import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import jwt from 'jsonwebtoken';
import { config } from '../../config';
import { logger } from '../../utils/logger';

// Note: Google Wallet reuses the GOOGLE_PLAY_CREDENTIALS service account
// (same one used for Google Play webhook verification in billing.ts)

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface WalletTicketData {
  ticketId: string;
  qrCode: string;
  eventName: string;
  eventDate: string; // ISO string for relevantDate
  eventDateDisplay: string; // Formatted display string like "Saturday, Jan 15"
  eventTime: string; // display string like "7:00 PM"
  eventLocation: string | null;
  eventAddress: string | null;
  tierName: string;
  customerName: string;
  organizationName: string;
  eventImageUrl?: string | null;
  eventBannerUrl?: string | null;
  apiUrl?: string;
  latitude?: number | null;
  longitude?: number | null;
  timezone?: string; // IANA timezone identifier like "America/New_York"
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPLE WALLET
// ═══════════════════════════════════════════════════════════════════════════════

let appleWalletAvailable = false;
let PKPass: any = null;

async function initAppleWallet() {
  try {
    const passkit = await import('passkit-generator');
    PKPass = passkit.PKPass;

    const wwdrPath = config.appleWallet.wwdrCertPath;
    const passTypeId = config.appleWallet.passTypeId;
    const teamId = config.appleWallet.teamId;

    if (!wwdrPath || !passTypeId || !teamId) {
      logger.warn('Apple Wallet not configured — missing env vars');
      return;
    }

    const resolvedCert = resolve('apple-wallet-cert.pem');
    const resolvedKey = resolve('apple-wallet-key.pem');
    const resolvedWwdr = resolve(wwdrPath);

    if (!existsSync(resolvedCert)) {
      logger.warn('Apple Wallet cert file not found', { path: resolvedCert });
      return;
    }
    if (!existsSync(resolvedKey)) {
      logger.warn('Apple Wallet key file not found', { path: resolvedKey });
      return;
    }
    if (!existsSync(resolvedWwdr)) {
      logger.warn('Apple WWDR cert file not found', { path: resolvedWwdr });
      return;
    }

    appleWalletAvailable = true;
    logger.info('Apple Wallet service initialized');
  } catch (error) {
    logger.warn('Apple Wallet init failed', { error });
  }
}

// Initialize on module load
initAppleWallet();

export async function generateAppleWalletPass(data: WalletTicketData): Promise<Buffer | null> {
  if (!appleWalletAvailable || !PKPass) {
    logger.warn('Apple Wallet not available, skipping pass generation');
    return null;
  }

  try {
    const signerCertPath = resolve('apple-wallet-cert.pem');
    const signerKeyPath = resolve('apple-wallet-key.pem');
    const wwdrPath = resolve(config.appleWallet.wwdrCertPath!);

    const signerCert = readFileSync(signerCertPath);
    const signerKey = readFileSync(signerKeyPath);
    const wwdrBuffer = readFileSync(wwdrPath);

    // Create pass from buffers (no model directory — we build it in memory)
    const passJson = {
      formatVersion: 1,
      passTypeIdentifier: config.appleWallet.passTypeId,
      teamIdentifier: config.appleWallet.teamId,
      organizationName: data.organizationName,
      description: `Ticket for ${data.eventName}`,
      serialNumber: data.ticketId,
      foregroundColor: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(17, 24, 39)',
      labelColor: 'rgb(156, 163, 175)',
      eventTicket: {
        primaryFields: [
          {
            key: 'event',
            label: 'EVENT',
            value: data.eventName,
          },
        ],
        secondaryFields: [
          {
            key: 'date',
            label: 'DATE',
            value: data.eventDateDisplay,
          },
          {
            key: 'time',
            label: 'TIME',
            value: data.eventTime,
          },
        ],
        auxiliaryFields: [
          {
            key: 'tier',
            label: 'TICKET',
            value: data.tierName,
          },
          {
            key: 'name',
            label: 'NAME',
            value: data.customerName,
          },
        ],
        backFields: [
          {
            key: 'ticketId',
            label: 'Ticket ID',
            value: data.ticketId,
          },
          {
            key: 'venue',
            label: 'Venue',
            value: data.eventLocation || 'See event details',
          },
        ],
      },
      barcodes: [
        {
          format: 'PKBarcodeFormatQR',
          message: data.qrCode,
          messageEncoding: 'iso-8859-1',
        },
      ],
      relevantDate: data.eventDate,
      locations: data.latitude && data.longitude ? [
        { latitude: data.latitude, longitude: data.longitude, relevantText: `Near ${data.eventLocation || data.eventName}` },
      ] : undefined,
    };

    if (data.eventLocation) {
      (passJson.eventTicket as any).auxiliaryFields.push({
        key: 'location',
        label: 'LOCATION',
        value: data.eventLocation,
      });
    }

    // Load icon and logo files required by Apple Wallet
    const imgDir = resolve('public');
    const loadImg = (name: string) => {
      const p = resolve(imgDir, name);
      return existsSync(p) ? readFileSync(p) : Buffer.alloc(0);
    };

    // Build pass from in-memory buffers
    const buffers: Record<string, Buffer> = {
      'pass.json': Buffer.from(JSON.stringify(passJson)),
      'icon.png': loadImg('wallet-icon.png'),
      'icon@2x.png': loadImg('wallet-icon@2x.png'),
      'icon@3x.png': loadImg('wallet-icon@3x.png'),
      'logo.png': loadImg('wallet-logo.png'),
      'logo@2x.png': loadImg('wallet-logo@2x.png'),
      'logo@3x.png': loadImg('wallet-logo@3x.png'),
    };

    logger.info('Building Apple Wallet pass', {
      ticketId: data.ticketId,
      bufferKeys: Object.keys(buffers),
      iconSize: buffers['icon.png']?.length || 0,
      certSize: signerCert.length,
      wwdrSize: wwdrBuffer.length,
    });

    const pass = new PKPass(
      buffers,
      {
        wwdr: wwdrBuffer,
        signerCert: signerCert,
        signerKey: signerKey,
        signerKeyPassphrase: config.appleWallet.certPassword || '',
      },
    );

    const buffer = pass.getAsBuffer();
    logger.info('Apple Wallet pass generated', { ticketId: data.ticketId });
    return buffer;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    logger.error('Failed to generate Apple Wallet pass', { error: errMsg, stack: errStack, ticketId: data.ticketId });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE WALLET
// ═══════════════════════════════════════════════════════════════════════════════

let googleWalletAvailable = false;
let googlePrivateKey: string | null = null;
let googleClientEmail: string | null = null;

function initGoogleWallet() {
  const { issuerId } = config.googleWallet;
  const credentialsRaw = config.googlePlay.credentials;

  if (!issuerId) {
    logger.warn('Google Wallet not configured — missing GOOGLE_WALLET_ISSUER_ID');
    return;
  }

  if (!credentialsRaw) {
    logger.warn('Google Wallet not configured — missing GOOGLE_PLAY_CREDENTIALS (service account)');
    return;
  }

  try {
    const credentials = JSON.parse(credentialsRaw);
    if (!credentials.private_key || !credentials.client_email) {
      logger.warn('Google Wallet — service account JSON missing private_key or client_email');
      return;
    }

    googlePrivateKey = credentials.private_key;
    googleClientEmail = credentials.client_email;
    googleWalletAvailable = true;
    logger.info('Google Wallet service initialized (using GOOGLE_PLAY_CREDENTIALS)');
  } catch (error) {
    logger.warn('Google Wallet init failed — could not parse GOOGLE_PLAY_CREDENTIALS', { error });
  }
}

initGoogleWallet();

export function generateGoogleWalletUrl(data: WalletTicketData): string | null {
  if (!googleWalletAvailable || !googlePrivateKey) {
    logger.warn('Google Wallet not available, skipping URL generation');
    return null;
  }

  try {
    const issuerId = config.googleWallet.issuerId!;
    const classId = `${issuerId}.luma_event_${data.ticketId.replace(/-/g, '_').substring(0, 8)}`;
    const objectId = `${issuerId}.luma_ticket_${data.ticketId.replace(/-/g, '_')}`;

    const apiUrl = data.apiUrl || process.env.API_URL || 'https://dev.api.lumapos.co';

    const eventTicketClass = {
      id: classId,
      issuerName: data.organizationName,
      reviewStatus: 'UNDER_REVIEW',
      logo: {
        sourceUri: {
          uri: `${apiUrl}/public/wallet-logo-google.png`,
        },
        contentDescription: {
          defaultValue: {
            language: 'en-US',
            value: 'Luma logo',
          },
        },
      },
      eventName: {
        defaultValue: {
          language: 'en-US',
          value: data.eventName,
        },
      },
      venue: data.eventLocation ? {
        name: {
          defaultValue: {
            language: 'en-US',
            value: data.eventLocation,
          },
        },
        address: data.eventAddress ? {
          defaultValue: {
            language: 'en-US',
            value: data.eventAddress,
          },
        } : undefined,
      } : undefined,
      dateTime: {
        start: data.eventDate,
        ...(data.timezone ? { customTimeZone: { id: data.timezone } } : {}),
      },
      ...(data.eventBannerUrl || data.eventImageUrl ? {
        heroImage: {
          sourceUri: {
            uri: data.eventBannerUrl || data.eventImageUrl!,
          },
          contentDescription: {
            defaultValue: {
              language: 'en-US',
              value: data.eventName,
            },
          },
        },
      } : {}),
    };

    const eventTicketObject = {
      id: objectId,
      classId: classId,
      state: 'ACTIVE',
      ticketHolderName: data.customerName,
      ticketNumber: data.ticketId.substring(0, 8).toUpperCase(),
      barcode: {
        type: 'QR_CODE',
        value: data.qrCode,
      },
      textModulesData: [
        {
          header: 'Ticket Type',
          body: data.tierName,
          id: 'tier',
        },
        {
          header: 'Date',
          body: data.eventDateDisplay,
          id: 'date',
        },
        {
          header: 'Time',
          body: data.eventTime,
          id: 'time',
        },
      ],
    };

    const claims = {
      iss: googleClientEmail!,
      aud: 'google',
      origins: ['*'],
      typ: 'savetowallet',
      payload: {
        eventTicketClasses: [eventTicketClass],
        eventTicketObjects: [eventTicketObject],
      },
    };

    const token = jwt.sign(claims, googlePrivateKey, { algorithm: 'RS256' });
    const url = `https://pay.google.com/gp/v/save/${token}`;

    logger.info('Google Wallet URL generated', { ticketId: data.ticketId });
    return url;
  } catch (error) {
    logger.error('Failed to generate Google Wallet URL', { error, ticketId: data.ticketId });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED HELPER
// ═══════════════════════════════════════════════════════════════════════════════

export interface WalletLinks {
  appleWalletUrl: string | null;
  googleWalletUrl: string | null;
}

export function isAppleWalletAvailable(): boolean {
  return appleWalletAvailable;
}

export function isGoogleWalletAvailable(): boolean {
  return googleWalletAvailable;
}
