import { describe, expect, it } from 'vitest';
import {
  attachmentParentSchema,
  createEmergencySessionSchema,
  createNoteSchema,
  dailySummaryPayloadSchema,
  emergencyLocationSchema,
  householdFeatureSettingsSchema,
  updateHouseholdFeatureSettingsSchema,
  updateNoteSchema,
  whatsappCallUrlSchema,
} from './index';

const id = '123e4567-e89b-42d3-a456-426614174000';
const fix = { latitude: 10, longitude: 20, locationAt: '2026-10-27T20:00:00+01:00' };

describe('family foundation contracts', () => {
  it('allows panic without location and requires a complete, finite latest fix when supplied', () => {
    expect(createEmergencySessionSchema.parse({})).toEqual({});
    expect(emergencyLocationSchema.parse(fix).accuracyMeters).toBeNull();
    for (const location of [
      { ...fix, longitude: undefined },
      { ...fix, locationAt: undefined },
      { ...fix, latitude: 91 },
      { ...fix, longitude: -181 },
      { ...fix, accuracyMeters: -1 },
      { ...fix, accuracyMeters: Infinity },
      { ...fix, latitude: NaN },
    ])
      expect(emergencyLocationSchema.safeParse(location).success).toBe(false);
    expect(createEmergencySessionSchema.safeParse({ sourceMemberId: id }).success).toBe(false);
    expect(createEmergencySessionSchema.safeParse({ expiresAt: fix.locationAt }).success).toBe(false);
  });

  it('validates note limits and excludes client-supplied author and household identity', () => {
    expect(createNoteSchema.parse({ title: ' Shopping ' })).toEqual({ title: 'Shopping', body: '' });
    expect(updateNoteSchema.parse({ title: 'Updated' })).toEqual({ title: 'Updated' });
    for (const note of [
      { title: ' ' },
      { title: 'x'.repeat(201) },
      { title: 'x', body: 'x'.repeat(10_001) },
      { title: 'x', authorMemberId: id },
      { title: 'x', householdId: id },
    ]) {
      expect(createNoteSchema.safeParse(note).success).toBe(false);
    }
  });

  it('requires exactly one attachment parent without accepting storage or uploader metadata', () => {
    expect(attachmentParentSchema.safeParse({ taskId: id }).success).toBe(true);
    expect(attachmentParentSchema.safeParse({ noteId: id, taskId: null }).success).toBe(true);
    for (const parent of [
      {},
      { taskId: null, noteId: null },
      { taskId: id, noteId: id },
      { taskId: 'bad' },
      { taskId: id, storageKey: 'private' },
      { taskId: id, uploaderMemberId: id },
    ]) {
      expect(attachmentParentSchema.safeParse(parent).success).toBe(false);
    }
  });

  it('uses settings defaults only on create, not on unrelated partial updates', () => {
    expect(householdFeatureSettingsSchema.parse({})).toEqual({
      dailySummaryEnabled: true,
      dailySummaryTime: '20:30',
      whatsappCallUrl: null,
    });
    expect(updateHouseholdFeatureSettingsSchema.parse({ whatsappCallUrl: null })).toEqual({
      whatsappCallUrl: null,
    });
    for (const dailySummaryTime of ['24:00', '20:60', '8:30', '20:30:00', '20:30\n']) {
      expect(householdFeatureSettingsSchema.safeParse({ dailySummaryTime }).success).toBe(false);
    }
    expect(householdFeatureSettingsSchema.safeParse({ householdId: id }).success).toBe(false);
  });

  it('allows only explicit HTTPS WhatsApp voice/video call links', () => {
    for (const kind of ['voice', 'video']) {
      expect(whatsappCallUrlSchema.safeParse(`https://call.whatsapp.com/${kind}/aBC_123-x`).success).toBe(
        true,
      );
    }
    for (const url of [
      'javascript:alert(1)',
      'http://call.whatsapp.com/voice/abc',
      'https://evil.test/voice/abc',
      'https://call.whatsapp.com.evil.test/voice/abc',
      'https://user@call.whatsapp.com/voice/abc',
      'https://call.whatsapp.com/voice/abc?redirect=evil',
      'https://wa.me/12345',
      'https://call.whatsapp.com/voice/abc\n',
    ]) {
      expect(whatsappCallUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  it('types durable summary content as rendered text with a generation timestamp', () => {
    expect(
      dailySummaryPayloadSchema.parse({ title: 'Today', body: 'Nothing due.', generatedAt: fix.locationAt }),
    ).toEqual({
      title: 'Today',
      body: 'Nothing due.',
      generatedAt: fix.locationAt,
    });
    expect(
      dailySummaryPayloadSchema.safeParse({ title: 'Today', body: '', generatedAt: 'not-a-date' }).success,
    ).toBe(false);
  });
});
