import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { redisService } from '../redis';

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
    const cached = await redisService.get(`socket:token:${token}`);
    if (cached) {
      return JSON.parse(cached);
    }
    return null;
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

      socket.join(`org:${user.organizationId}`);
      socket.join(`user:${user.userId}`);

      socket.on('join:event', (eventId: string) => {
        socket.join(`event:${eventId}`);
        logger.debug('Socket joined event', { socketId: socket.id, eventId });
      });

      socket.on('leave:event', (eventId: string) => {
        socket.leave(`event:${eventId}`);
        logger.debug('Socket left event', { socketId: socket.id, eventId });
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
    if (!this.io) return;
    this.io.to(`org:${organizationId}`).emit(event, data);
    logger.debug('Emitted to organization', { organizationId, event });
  }

  emitToEvent(eventId: string, event: string, data: any) {
    if (!this.io) return;
    this.io.to(`event:${eventId}`).emit(event, data);
    logger.debug('Emitted to event', { eventId, event });
  }

  emitToUser(userId: string, event: string, data: any) {
    if (!this.io) return;
    this.io.to(`user:${userId}`).emit(event, data);
    logger.debug('Emitted to user', { userId, event });
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
  ORDER_CREATED: 'order:created',
  ORDER_UPDATED: 'order:updated',
  ORDER_COMPLETED: 'order:completed',
  PAYMENT_RECEIVED: 'payment:received',
  TIP_UPDATED: 'tip:updated',
  EVENT_STARTED: 'event:started',
  EVENT_ENDED: 'event:ended',
  REVENUE_UPDATE: 'revenue:update',
  STAFF_JOINED: 'staff:joined',
  STAFF_LEFT: 'staff:left',
} as const;