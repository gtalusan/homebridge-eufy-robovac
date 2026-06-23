import { describe, expect, it } from 'vitest';

import { EufyCleanCloudRobovac } from '../../src/robovac/EufyCleanCloudRobovac.js';

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function fieldVarint(field: number, value: number): Buffer {
  return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}

function fieldBytes(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

function roomData(id: number, name: string): Buffer {
  return Buffer.concat([
    fieldVarint(1, id),
    fieldBytes(2, Buffer.from(name, 'utf8')),
  ]);
}

describe('EufyCleanCloudRobovac room discovery', () => {
  it('extracts room ids and labels from protobuf-ish startup metadata', () => {
    const roomTable = Buffer.concat([
      fieldVarint(1, 1234),
      fieldBytes(2, roomData(1, 'Kitchen')),
      fieldBytes(2, roomData(2, 'Hallway')),
    ]);
    const universalDataResponse = fieldBytes(1, roomTable);
    const client = new EufyCleanCloudRobovac({});
    const entries = (
      client as unknown as {
        discoveredRoomEntries(value: unknown): Array<{ id: string; label: string; source: string }>;
      }
    ).discoveredRoomEntries({
      dps: {
        125: universalDataResponse.toString('base64'),
      },
    });

    expect(entries).toEqual([
      { id: '1', label: 'Kitchen', source: 'dps.125' },
      { id: '2', label: 'Hallway', source: 'dps.125' },
    ]);
  });

  it('does not report ordinary ids as encoded protobuf candidates', () => {
    const client = new EufyCleanCloudRobovac({});
    const summary = (
      client as unknown as {
        encodedRoomMetadataSummary(value: unknown[]): string;
      }
    ).encodedRoomMetadataSummary([{
      id: 'bf299237f6f8db6d73efhs',
      room_id: '123456789012345678901234567',
      dps: {
        15: 'charge',
      },
    }]);

    expect(summary).toBe('');
  });
});
