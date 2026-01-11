import { query } from '../../db';
import { RevenueSplit, RevenueSplitReport, RevenueSplitRecipientType, Catalog } from '../../db/models';
import { logger } from '../../utils/logger';

export interface CreateSplitParams {
  catalogId: string;
  organizationId: string;
  recipientName: string;
  recipientType: RevenueSplitRecipientType;
  percentage: number;
  notes?: string;
}

export interface UpdateSplitParams {
  recipientName?: string;
  recipientType?: RevenueSplitRecipientType;
  percentage?: number;
  notes?: string | null;
  isActive?: boolean;
}

class SplitsService {
  /**
   * List all revenue splits for a catalog
   */
  async listByCatalog(catalogId: string, organizationId: string): Promise<RevenueSplit[]> {
    const result = await query<RevenueSplit>(
      `SELECT * FROM revenue_splits
       WHERE catalog_id = $1 AND organization_id = $2
       ORDER BY created_at ASC`,
      [catalogId, organizationId]
    );
    return result;
  }

  /**
   * Get a single revenue split by ID
   */
  async getById(splitId: string, organizationId: string): Promise<RevenueSplit | null> {
    const result = await query<RevenueSplit>(
      `SELECT * FROM revenue_splits WHERE id = $1 AND organization_id = $2`,
      [splitId, organizationId]
    );
    return result[0] || null;
  }

  /**
   * Create a new revenue split
   */
  async create(params: CreateSplitParams): Promise<RevenueSplit> {
    // Validate percentage
    if (params.percentage < 0 || params.percentage > 100) {
      throw new Error('Percentage must be between 0 and 100');
    }

    // Verify catalog exists and belongs to organization
    const catalog = await query<Catalog>(
      'SELECT id FROM catalogs WHERE id = $1 AND organization_id = $2',
      [params.catalogId, params.organizationId]
    );

    if (catalog.length === 0) {
      throw new Error('Catalog not found');
    }

    const result = await query<RevenueSplit>(
      `INSERT INTO revenue_splits (
        catalog_id, organization_id, recipient_name, recipient_type, percentage, notes
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        params.catalogId,
        params.organizationId,
        params.recipientName,
        params.recipientType,
        params.percentage,
        params.notes || null,
      ]
    );

    logger.info('Created revenue split', {
      splitId: result[0].id,
      catalogId: params.catalogId,
      recipientName: params.recipientName,
      percentage: params.percentage,
    });

    return result[0];
  }

  /**
   * Update a revenue split
   */
  async update(
    splitId: string,
    organizationId: string,
    updates: UpdateSplitParams
  ): Promise<RevenueSplit | null> {
    // Check split exists
    const existing = await this.getById(splitId, organizationId);
    if (!existing) {
      return null;
    }

    // Validate percentage if provided
    if (updates.percentage !== undefined && (updates.percentage < 0 || updates.percentage > 100)) {
      throw new Error('Percentage must be between 0 and 100');
    }

    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.recipientName !== undefined) {
      setClauses.push(`recipient_name = $${paramIndex++}`);
      params.push(updates.recipientName);
    }
    if (updates.recipientType !== undefined) {
      setClauses.push(`recipient_type = $${paramIndex++}`);
      params.push(updates.recipientType);
    }
    if (updates.percentage !== undefined) {
      setClauses.push(`percentage = $${paramIndex++}`);
      params.push(updates.percentage);
    }
    if (updates.notes !== undefined) {
      setClauses.push(`notes = $${paramIndex++}`);
      params.push(updates.notes);
    }
    if (updates.isActive !== undefined) {
      setClauses.push(`is_active = $${paramIndex++}`);
      params.push(updates.isActive);
    }

    if (setClauses.length === 0) {
      return existing;
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(splitId, organizationId);

    const result = await query<RevenueSplit>(
      `UPDATE revenue_splits SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex++} AND organization_id = $${paramIndex}
       RETURNING *`,
      params
    );

    logger.info('Updated revenue split', { splitId, updates });

    return result[0];
  }

  /**
   * Delete a revenue split
   */
  async delete(splitId: string, organizationId: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM revenue_splits WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [splitId, organizationId]
    );

    if (result.length === 0) {
      return false;
    }

    logger.info('Deleted revenue split', { splitId });
    return true;
  }

  /**
   * Get revenue split report for a catalog within a date range
   */
  async getReport(
    catalogId: string,
    organizationId: string,
    startDate: string,
    endDate: string
  ): Promise<RevenueSplitReport> {
    // Get catalog info
    const catalogResult = await query<Catalog>(
      'SELECT id, name FROM catalogs WHERE id = $1 AND organization_id = $2',
      [catalogId, organizationId]
    );

    if (catalogResult.length === 0) {
      throw new Error('Catalog not found');
    }

    const catalog = catalogResult[0];

    // Get gross sales (subtotal before tax/tip) from completed orders
    const salesResult = await query<{
      gross_sales: string;
      order_count: string;
    }>(
      `SELECT
        COALESCE(SUM(subtotal), 0) as gross_sales,
        COUNT(*) as order_count
      FROM orders
      WHERE organization_id = $1
        AND catalog_id = $2
        AND status = 'completed'
        AND created_at >= $3::date
        AND created_at < ($4::date + interval '1 day')`,
      [organizationId, catalogId, startDate, endDate]
    );

    // subtotal is stored in dollars (DECIMAL), convert to cents for API response
    const grossSales = Math.round(parseFloat(salesResult[0].gross_sales) * 100) || 0;
    const orderCount = parseInt(salesResult[0].order_count) || 0;

    // Get active splits for this catalog
    const splitsResult = await query<RevenueSplit>(
      `SELECT * FROM revenue_splits
       WHERE catalog_id = $1 AND organization_id = $2 AND is_active = true
       ORDER BY created_at ASC`,
      [catalogId, organizationId]
    );

    // Calculate each split amount
    let totalSplitAmount = 0;
    const splits = splitsResult.map(split => {
      const amount = Math.round((grossSales * split.percentage) / 100);
      totalSplitAmount += amount;
      return {
        id: split.id,
        recipientName: split.recipient_name,
        recipientType: split.recipient_type,
        percentage: Number(split.percentage),
        amount,
      };
    });

    const yourShare = grossSales - totalSplitAmount;

    return {
      catalogId,
      catalogName: catalog.name,
      period: {
        startDate,
        endDate,
      },
      summary: {
        grossSales,
        totalSplitAmount,
        yourShare,
        orderCount,
      },
      splits,
    };
  }

  /**
   * Get total split percentage for a catalog (for validation/display)
   */
  async getTotalSplitPercentage(catalogId: string, organizationId: string): Promise<number> {
    const result = await query<{ total: string }>(
      `SELECT COALESCE(SUM(percentage), 0) as total
       FROM revenue_splits
       WHERE catalog_id = $1 AND organization_id = $2 AND is_active = true`,
      [catalogId, organizationId]
    );
    return Number(result[0].total) || 0;
  }
}

export const splitsService = new SplitsService();
