import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { authService } from '../auth';

export interface SocketUser {
  userId: string;
  organizationId: string;
  role: string;
}

export class SocketService {
  private io: SocketIOServer | null = null;
  private connectedUsers: Map<string, SocketUser> = new Map();

  initialize(server: HTTPServer) {
    this.io = new SocketIOServer(server, {
      path: config.socketio.path,
      cors: {
        origin: config.cors.origin.split(','),
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    this.setupMiddleware();
    this.setupEventHandlers();

    logger.info('Socket.IO initialized');
  }

  private setupMiddleware() {
    if (!this.io) return;

    // Public namespace for anonymous event page connections (marketing site)
    const publicNs = this.io.of('/public');
    publicNs.on('connection', (socket) => {
      logger.debug('Public socket connected', { socketId: socket.id });

      socket.on('join', (room: string) => {
        // Only allow joining event-specific, preorder-specific, catalog-specific, or public rooms
        if (room === 'events:public' || room.startsWith('event:') || room.startsWith('preorder:') || room.startsWith('catalog:')) {
          socket.join(room);
          logger.debug('Public socket joined room', { socketId: socket.id, room });
        }
      });

      socket.on('disconnect', () => {
        logger.debug('Public socket disconnected', { socketId: socket.id });
      });
    });

    // Authenticated namespace (default)
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        if (!token) {
          return next(new Error('Authentication required'));
        }

        const user = await this.validateToken(token);
        if (!user) {
          return next(new Error('Invalid token'));
        }

        socket.data.user = user;
        next();
      } catch (error) {
        logger.error('Socket authentication error', error);
        next(new Error('Authentication failed'));
      }
    });
  }

  private async validateToken(token: string): Promise<SocketUser | null> {
    try {
      const payload = await authService.verifyToken(token);
      return {
        userId: payload.userId,
        organizationId: payload.organizationId,
        role: payload.role,
      };
    } catch (error) {
      logger.debug('Socket token validation failed', { error });
      return null;
    }
  }

  private setupEventHandlers() {
    if (!this.io) return;

    this.io.on('connection', (socket) => {
      const user = socket.data.user as SocketUser;
      logger.info('Socket connected', {
        socketId: socket.id,
        userId: user.userId,
        organizationId: user.organizationId,
      });

      this.connectedUsers.set(socket.id, user);

      const orgRoom = `org:${user.organizationId}`;
      const userRoom = `user:${user.userId}`;
      socket.join(orgRoom);
      socket.join(userRoom);

      logger.info('[SOCKET DEBUG] User joined rooms', {
        socketId: socket.id,
        userId: user.userId,
        organizationId: user.organizationId,
        joinedRooms: [orgRoom, userRoom],
      });

      socket.on('join:event', (eventId: string) => {
        socket.join(`event:${eventId}`);
        logger.debug('Socket joined event', { socketId: socket.id, eventId });
      });

      socket.on('leave:event', (eventId: string) => {
        socket.leave(`event:${eventId}`);
        logger.debug('Socket left event', { socketId: socket.id, eventId });
      });

      // Device room support - allows emitting to specific devices
      socket.on('join:device', (deviceId: string) => {
        socket.join(`device:${deviceId}`);
        logger.debug('Socket joined device room', { socketId: socket.id, deviceId });
      });

      socket.on('leave:device', (deviceId: string) => {
        socket.leave(`device:${deviceId}`);
        logger.debug('Socket left device room', { socketId: socket.id, deviceId });
      });

      socket.on('order:update', async (data: any) => {
        await this.handleOrderUpdate(socket, data);
      });

      socket.on('disconnect', () => {
        this.connectedUsers.delete(socket.id);
        logger.info('Socket disconnected', { socketId: socket.id });
      });
    });
  }

  private async handleOrderUpdate(socket: any, data: any) {
    const user = socket.data.user as SocketUser;
    logger.debug('Order update received', {
      userId: user.userId,
      orderId: data.orderId,
      status: data.status,
    });

    if (data.eventId) {
      this.emitToEvent(data.eventId, 'order:updated', {
        orderId: data.orderId,
        status: data.status,
        updatedBy: user.userId,
        timestamp: new Date(),
      });
    }
  }

  emitToOrganization(organizationId: string, event: string, data: any) {
    if (!this.io) {
      logger.warn('Socket.IO not initialized, cannot emit to organization', { organizationId, event });
      return;
    }
    const room = `org:${organizationId}`;
    const socketsInRoom = this.io.sockets.adapter.rooms.get(room);
    const socketCount = socketsInRoom?.size || 0;

    // Log all available rooms for debugging
    const allRooms = Array.from(this.io.sockets.adapter.rooms.keys()).filter(r => r.startsWith('org:'));
    logger.info('[SOCKET DEBUG] Available org rooms', { allOrgRooms: allRooms });

    this.io.to(room).emit(event, data);
    logger.info('Emitted to organization', {
      organizationId,
      event,
      room,
      connectedSockets: socketCount,
      roomExists: socketsInRoom !== undefined,
      data
    });

    // If no sockets in room, log this as a warning
    if (socketCount === 0) {
      logger.warn('[SOCKET DEBUG] No connected sockets in target room!', {
        targetRoom: room,
        availableOrgRooms: allRooms,
        totalConnectedUsers: this.connectedUsers.size,
      });
    }
  }

  emitToEvent(eventId: string, event: string, data: any) {
    if (!this.io) return;
    // Emit to authenticated clients in event room
    this.io.to(`event:${eventId}`).emit(event, data);
    // Also emit to public namespace for marketing site viewers
    this.io.of('/public').to(`event:${eventId}`).emit(event, data);
    this.io.of('/public').to('events:public').emit(event, data);
    logger.debug('Emitted to event', { eventId, event });
  }

  emitToPreorder(preorderId: string, event: string, data: any) {
    if (!this.io) return;
    // Emit to public namespace for customer tracking their preorder
    this.io.of('/public').to(`preorder:${preorderId}`).emit(event, data);
    logger.debug('Emitted to preorder', { preorderId, event });
  }

  emitToCatalog(catalogId: string, event: string, data: any) {
    if (!this.io) return;
    // Emit to public namespace for marketing site menu pages
    this.io.of('/public').to(`catalog:${catalogId}`).emit(event, data);
    logger.debug('Emitted to catalog (public)', { catalogId, event });
  }

  emitToUser(userId: string, event: string, data: any) {
    if (!this.io) return;
    this.io.to(`user:${userId}`).emit(event, data);
    logger.debug('Emitted to user', { userId, event });
  }

  emitToDevice(deviceId: string, event: string, data: any) {
    if (!this.io) {
      logger.warn('Socket.IO not initialized, cannot emit to device', { deviceId, event });
      return;
    }
    const room = `device:${deviceId}`;
    const socketsInRoom = this.io.sockets.adapter.rooms.get(room);
    const socketCount = socketsInRoom?.size || 0;

    this.io.to(room).emit(event, data);
    logger.info('Emitted to device', {
      deviceId,
      event,
      room,
      connectedSockets: socketCount,
      data
    });
  }

  broadcast(event: string, data: any) {
    if (!this.io) return;
    this.io.emit(event, data);
    logger.debug('Broadcast event', { event });
  }

  getConnectedUsers(): SocketUser[] {
    return Array.from(this.connectedUsers.values());
  }

  getConnectedUsersCount(): number {
    return this.connectedUsers.size;
  }

  async disconnectUser(userId: string) {
    if (!this.io) return;

    const sockets = await this.io.fetchSockets();
    for (const socket of sockets) {
      const user = socket.data.user as SocketUser;
      if (user && user.userId === userId) {
        socket.disconnect(true);
      }
    }
  }
}

export const socketService = new SocketService();

export const SocketEvents = {
  // Order events
  ORDER_CREATED: 'order:created',
  ORDER_UPDATED: 'order:updated',
  ORDER_COMPLETED: 'order:completed',
  ORDER_FAILED: 'order:failed',
  ORDER_REFUNDED: 'order:refunded',
  ORDER_DELETED: 'order:deleted',
  // Payment events
  PAYMENT_RECEIVED: 'payment:received',
  REVENUE_UPDATE: 'revenue:update',
  TIP_UPDATED: 'tip:updated',
  // Stripe Connect events
  CONNECT_STATUS_UPDATED: 'connect:status_updated',
  // Subscription events
  SUBSCRIPTION_UPDATED: 'subscription:updated',
  // User events
  USER_UPDATED: 'user:updated',
  // Session events
  SESSION_KICKED: 'session:kicked', // Emitted when user logs in on another device
  // Organization events
  ORGANIZATION_UPDATED: 'organization:updated',
  // Catalog events
  CATALOG_UPDATED: 'catalog:updated',
  CATALOG_CREATED: 'catalog:created',
  CATALOG_DELETED: 'catalog:deleted',
  // Product events
  PRODUCT_UPDATED: 'product:updated',
  PRODUCT_CREATED: 'product:created',
  PRODUCT_DELETED: 'product:deleted',
  // Category events
  CATEGORY_UPDATED: 'category:updated',
  CATEGORY_CREATED: 'category:created',
  CATEGORY_DELETED: 'category:deleted',
  CATEGORIES_REORDERED: 'categories:reordered',
  // Event events
  EVENT_CREATED: 'event:created',
  EVENT_UPDATED: 'event:updated',
  EVENT_DELETED: 'event:deleted',
  // Ticket events
  TICKET_PURCHASED: 'ticket:purchased',
  TICKET_SCANNED: 'ticket:scanned',
  TICKET_REFUNDED: 'ticket:refunded',
  // Preorder events
  PREORDER_CREATED: 'preorder:created',
  PREORDER_UPDATED: 'preorder:updated',
  PREORDER_READY: 'preorder:ready',
  PREORDER_COMPLETED: 'preorder:completed',
  PREORDER_CANCELLED: 'preorder:cancelled',
} as const;