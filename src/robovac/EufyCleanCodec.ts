import type { RobovacEvent } from './types.js';

export type CloudCommand =
  | 'clean'
  | 'pause'
  | 'resume'
  | 'goHome'
  | 'cleanRooms'
  | 'locate'
  | 'cleanSpeed';

export interface EncodedCommand {
  protocol: 'json';
  sequence: number;
  command: CloudCommand;
  deviceId: string;
  payload: Record<string, unknown>;
}

export interface DecodedStatus {
  dps: Record<string, unknown>;
  events: RobovacEvent[];
}

const COMMAND_CODES: Record<CloudCommand, number> = {
  clean: 101,
  pause: 102,
  resume: 103,
  goHome: 104,
  cleanRooms: 105,
  locate: 106,
  cleanSpeed: 107,
};

const STATUS_KEYS: Record<number, string> = {
  1: 'activity',
  2: 'battery',
  3: 'error',
  4: 'goHome',
  5: 'locate',
  102: 'cleanSpeed',
};

export class EufyCleanCodec {
  private sequence = 0;

  encodeCommand(deviceId: string, command: CloudCommand, payload: Record<string, unknown> = {}): Buffer {
    const message: EncodedCommand & { code: number; timestamp: number } = {
      protocol: 'json',
      sequence: ++this.sequence,
      command,
      code: COMMAND_CODES[command],
      deviceId,
      timestamp: Date.now(),
      payload,
    };
    return Buffer.from(JSON.stringify(message));
  }

  decodeStatus(payload: Buffer): DecodedStatus {
    const jsonStatus = this.tryDecodeJson(payload);
    if (jsonStatus) {
      return jsonStatus;
    }
    return this.decodeProtoLike(payload);
  }

  private tryDecodeJson(payload: Buffer): DecodedStatus | undefined {
    try {
      const parsed = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
      const source = this.asRecord(parsed.payload) ?? parsed;
      const dps = this.asRecord(source.dps) ?? source;
      return this.toStatus(dps);
    } catch {
      return undefined;
    }
  }

  private decodeProtoLike(payload: Buffer): DecodedStatus {
    const dps: Record<string, unknown> = {};
    let offset = 0;

    while (offset < payload.length) {
      const tag = this.readVarint(payload, offset);
      if (!tag) {
        break;
      }
      offset = tag.nextOffset;
      const fieldNumber = tag.value >> 3;
      const wireType = tag.value & 0x07;
      const key = STATUS_KEYS[fieldNumber] ?? String(fieldNumber);

      if (wireType === 0) {
        const value = this.readVarint(payload, offset);
        if (!value) {
          break;
        }
        dps[key] = value.value;
        offset = value.nextOffset;
      } else if (wireType === 2) {
        const length = this.readVarint(payload, offset);
        if (!length) {
          break;
        }
        offset = length.nextOffset;
        const end = offset + length.value;
        if (end > payload.length) {
          break;
        }
        dps[key] = payload.subarray(offset, end).toString('utf8');
        offset = end;
      } else {
        break;
      }
    }

    return this.toStatus(dps);
  }

  private toStatus(dps: Record<string, unknown>): DecodedStatus {
    const events = Object.entries(dps).map(([command, value]) => ({
      command,
      value: this.normalizeValue(value),
    }));
    return { dps, events };
  }

  private normalizeValue(value: unknown): RobovacEvent['value'] {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' || value === null) {
      return value;
    }
    if (typeof value === 'object') {
      return value as object;
    }
    return String(value);
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
  }

  private readVarint(buffer: Buffer, start: number): { value: number; nextOffset: number } | undefined {
    let value = 0;
    let shift = 0;
    let offset = start;

    while (offset < buffer.length && shift < 35) {
      const byte = buffer[offset++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return { value, nextOffset: offset };
      }
      shift += 7;
    }
    return undefined;
  }
}
