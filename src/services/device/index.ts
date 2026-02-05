import { query } from '../../db';
import { Device, UserDevice } from '../../db/models';
import { logger } from '../../utils/logger';

export interface DeviceInfo {
  deviceId: string;
  name?: string;
  model?: string;
  os?: string;
  osVersion?: string;
  appVersion?: string;
}

export interface DeviceWithUsers extends Device {
  users?: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    lastLoginAt: Date;
    loginCount: number;
  }>;
}

export class DeviceService {
  /**
   * Register or update a device. Creates the device if it doesn't exist,
   * or updates the device info and last_seen_at if it does.
   */
  async upsertDevice(organizationId: string, info: DeviceInfo, userId?: string): Promise<Device> {
    const result = await query<Device>(
      `INSERT INTO devices (
        device_id, organization_id, device_name, model_name, os_name, os_version, app_version,
        last_user_id, last_seen_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (device_id) DO UPDATE SET
        device_name = COALESCE(EXCLUDED.device_name, devices.device_name),
        model_name = COALESCE(EXCLUDED.model_name, devices.model_name),
        os_name = COALESCE(EXCLUDED.os_name, devices.os_name),
        os_version = COALESCE(EXCLUDED.os_version, devices.os_version),
        app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
        last_user_id = COALESCE(EXCLUDED.last_user_id, devices.last_user_id),
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING *`,
      [
        info.deviceId,
        organizationId,
        info.name || null,
        info.model || null,
        info.os || null,
        info.osVersion || null,
        info.appVersion || null,
        userId || null,
      ]
    );

    const device = result[0];

    logger.debug('Device upserted', {
      deviceId: info.deviceId,
      dbId: device.id,
      organizationId,
      model: info.model,
    });

    return device;
  }

  /**
   * Link a user to a device. Creates the relationship if it doesn't exist,
   * or updates the last_login_at and login_count if it does.
   */
  async linkUserToDevice(userId: string, deviceDbId: string): Promise<UserDevice> {
    const result = await query<UserDevice>(
      `INSERT INTO user_devices (user_id, device_id, first_login_at, last_login_at, login_count)
      VALUES ($1, $2, NOW(), NOW(), 1)
      ON CONFLICT (user_id, device_id) DO UPDATE SET
        last_login_at = NOW(),
        login_count = user_devices.login_count + 1,
        updated_at = NOW()
      RETURNING *`,
      [userId, deviceDbId]
    );

    const userDevice = result[0];

    logger.debug('User linked to device', {
      userId,
      deviceDbId,
      loginCount: userDevice.login_count,
    });

    return userDevice;
  }

  /**
   * Get a device by its app-generated device ID
   */
  async getDeviceByAppId(deviceId: string): Promise<Device | null> {
    const result = await query<Device>(
      `SELECT * FROM devices WHERE device_id = $1`,
      [deviceId]
    );
    return result[0] || null;
  }

  /**
   * Get a device by its database UUID
   */
  async getDeviceById(id: string): Promise<Device | null> {
    const result = await query<Device>(
      `SELECT * FROM devices WHERE id = $1`,
      [id]
    );
    return result[0] || null;
  }

  /**
   * Get all devices for an organization
   */
  async getOrganizationDevices(organizationId: string): Promise<Device[]> {
    const result = await query<Device>(
      `SELECT * FROM devices
       WHERE organization_id = $1
       ORDER BY last_seen_at DESC`,
      [organizationId]
    );
    return result;
  }

  /**
   * Get all devices used by a specific user
   */
  async getUserDevices(userId: string): Promise<Device[]> {
    const result = await query<Device>(
      `SELECT d.* FROM devices d
       INNER JOIN user_devices ud ON d.id = ud.device_id
       WHERE ud.user_id = $1 AND ud.is_active = true
       ORDER BY ud.last_login_at DESC`,
      [userId]
    );
    return result;
  }

  /**
   * Get all users who have logged in on a specific device
   */
  async getDeviceUsers(deviceDbId: string): Promise<Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    lastLoginAt: Date;
    loginCount: number;
  }>> {
    const result = await query<{
      id: string;
      email: string;
      first_name: string | null;
      last_name: string | null;
      last_login_at: Date;
      login_count: number;
    }>(
      `SELECT u.id, u.email, u.first_name, u.last_name, ud.last_login_at, ud.login_count
       FROM users u
       INNER JOIN user_devices ud ON u.id = ud.user_id
       WHERE ud.device_id = $1 AND ud.is_active = true
       ORDER BY ud.last_login_at DESC`,
      [deviceDbId]
    );

    return result.map(r => ({
      id: r.id,
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      lastLoginAt: r.last_login_at,
      loginCount: r.login_count,
    }));
  }

  /**
   * Update device's last seen timestamp
   */
  async updateLastSeen(deviceId: string, userId?: string): Promise<void> {
    await query(
      `UPDATE devices SET
        last_seen_at = NOW(),
        last_user_id = COALESCE($2, last_user_id),
        updated_at = NOW()
       WHERE device_id = $1`,
      [deviceId, userId || null]
    );
  }

  /**
   * Enable Tap to Pay for a device
   */
  async setTapToPayEnabled(deviceId: string, enabled: boolean): Promise<Device | null> {
    const result = await query<Device>(
      `UPDATE devices SET
        has_tap_to_pay = $2,
        tap_to_pay_enabled_at = CASE WHEN $2 = true THEN COALESCE(tap_to_pay_enabled_at, NOW()) ELSE tap_to_pay_enabled_at END,
        updated_at = NOW()
       WHERE device_id = $1
       RETURNING *`,
      [deviceId, enabled]
    );
    return result[0] || null;
  }

  /**
   * Get device with its associated users
   */
  async getDeviceWithUsers(deviceDbId: string): Promise<DeviceWithUsers | null> {
    const device = await this.getDeviceById(deviceDbId);
    if (!device) {
      return null;
    }

    const users = await this.getDeviceUsers(deviceDbId);

    return {
      ...device,
      users,
    };
  }

  /**
   * Convenience method to handle device registration on login.
   * Creates/updates the device and links the user to it.
   */
  async registerDeviceOnLogin(
    organizationId: string,
    userId: string,
    info: DeviceInfo
  ): Promise<{ device: Device; userDevice: UserDevice }> {
    // Upsert the device
    const device = await this.upsertDevice(organizationId, info, userId);

    // Link user to device
    const userDevice = await this.linkUserToDevice(userId, device.id);

    logger.info('Device registered on login', {
      deviceId: info.deviceId,
      dbId: device.id,
      userId,
      organizationId,
      model: info.model,
      os: info.os,
      loginCount: userDevice.login_count,
    });

    return { device, userDevice };
  }
}

export const deviceService = new DeviceService();
