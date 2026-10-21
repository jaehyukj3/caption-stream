import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Room } from './Room.js';

const MAX_ROOMS = 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private sweepTimer: NodeJS.Timeout | null = null;

  start(): void {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }

  create(): Room | null {
    if (this.rooms.size >= MAX_ROOMS) {
      this.sweep();
      if (this.rooms.size >= MAX_ROOMS) return null;
    }
    let code: string;
    do {
      code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    } while (this.rooms.has(code));

    const room = new Room(code, randomBytes(24).toString('base64url'));
    this.rooms.set(code, room);
    console.log(`[room] created ${code} (total ${this.rooms.size})`);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  verifyHost(room: Room, token: string | undefined): boolean {
    if (!token) return false;
    const a = Buffer.from(room.hostToken);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  sweep(now = Date.now()): void {
    for (const [code, room] of this.rooms) {
      if (room.isExpired(now)) {
        room.dispose();
        this.rooms.delete(code);
        console.log(`[room] expired ${code}`);
      }
    }
  }
}
