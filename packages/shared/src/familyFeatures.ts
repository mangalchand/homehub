import { z } from 'zod';

export const IMAGE_ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const DAILY_SUMMARY_STATUSES = ['PENDING', 'CLAIMED', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type ImageAttachmentMimeType = (typeof IMAGE_ATTACHMENT_MIME_TYPES)[number];
export type DailySummaryStatus = (typeof DAILY_SUMMARY_STATUSES)[number];

const isoDateTime = z.string().datetime({ offset: true });

/** Only the latest fix is stored. Identity, household and expiry are always server-derived. */
export const emergencyLocationSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracyMeters: z.number().finite().min(0).nullable().default(null),
    locationAt: isoDateTime,
  })
  .strict();
export const createEmergencySessionSchema = z
  .object({ location: emergencyLocationSchema.optional() })
  .strict();
export const updateEmergencyLocationSchema = emergencyLocationSchema;
export type EmergencyLocation = z.infer<typeof emergencyLocationSchema>;
export type CreateEmergencySessionInput = z.infer<typeof createEmergencySessionSchema>;

export const createNoteSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(10_000).default(''),
  })
  .strict();
export const updateNoteSchema = createNoteSchema.partial();
export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

export const attachmentParentSchema = z
  .object({
    taskId: z.string().uuid().nullable().optional(),
    noteId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((parent) => Boolean(parent.taskId) !== Boolean(parent.noteId), {
    message: 'Exactly one taskId or noteId is required',
  });
export type AttachmentParentInput = z.infer<typeof attachmentParentSchema>;

export const whatsappCallUrlSchema = z
  .string()
  .max(500)
  .regex(
    /^https:\/\/call\.whatsapp\.com\/(voice|video)\/[A-Za-z0-9_-]+$/,
    'Use a WhatsApp voice or video call link',
  )
  .refine((url) => url === url.trim(), 'Call links cannot contain surrounding whitespace');
export const householdFeatureSettingsSchema = z
  .object({
    dailySummaryEnabled: z.boolean().default(true),
    dailySummaryTime: z
      .string()
      .length(5)
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('20:30'),
    whatsappCallUrl: whatsappCallUrlSchema.nullable().default(null),
  })
  .strict();
export const updateHouseholdFeatureSettingsSchema = householdFeatureSettingsSchema.partial();
export type HouseholdFeatureSettingsInput = z.infer<typeof householdFeatureSettingsSchema>;
export type UpdateHouseholdFeatureSettingsInput = z.infer<typeof updateHouseholdFeatureSettingsSchema>;

/** Persist the rendered text so retrying a run does not generate different content. */
export const dailySummaryPayloadSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(20_000),
    generatedAt: isoDateTime,
  })
  .strict();
export type DailySummaryPayload = z.infer<typeof dailySummaryPayloadSchema>;

export interface EmergencySessionDTO {
  id: string;
  householdId: string;
  sourceMemberId: string | null;
  sourceDeviceId: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  locationAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  stoppedAt: string | null;
}

/** Storage keys are private; image retrieval must resolve attachment id through household authorization. */
export type AttachmentDTO = {
  id: string;
  householdId: string;
  uploaderMemberId: string | null;
  uploaderDeviceId: string | null;
  mimeType: ImageAttachmentMimeType;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  updatedAt: string;
} & ({ taskId: string; noteId: null } | { taskId: null; noteId: string });

export interface NoteDTO {
  id: string;
  householdId: string;
  title: string;
  body: string;
  authorMemberId: string | null;
  authorDeviceId: string | null;
  createdAt: string;
  updatedAt: string;
  attachments: AttachmentDTO[];
}

export interface HouseholdFeatureSettingsDTO extends HouseholdFeatureSettingsInput {
  householdId: string;
  createdAt: string;
  updatedAt: string;
}

/** Lease tokens and internal errors are worker-only; do not serialize raw Prisma run rows. */
export interface DailySummaryRunDTO {
  id: string;
  householdId: string;
  /** YYYY-MM-DD in Household.timezone, not the UTC date when the worker ran. */
  localDate: string;
  status: DailySummaryStatus;
  attempts: number;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  payload: DailySummaryPayload | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}
