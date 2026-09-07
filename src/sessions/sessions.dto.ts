import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';

export class CreateSessionDto {
  // Optional client-generated id (the Trainer App mints this locally,
  // offline-first, before it ever reaches the cloud — see
  // uvactive-trainer-app/src/services/sessionEngine.ts). When present,
  // this becomes the row's real id instead of the Prisma-side
  // @default(uuid()), so the local SQLite id and the cloud id are the
  // SAME value from creation onward. That's what lets every later
  // sync-queue event (start/readings/end/cancel/enroll) reference a
  // session id that's valid immediately, with no reconciliation step
  // and nothing to rewrite in local storage after the fact.
  @IsOptional() @IsUUID() id?: string;
  @IsString() name!: string;
  // Capacity is NEVER client-supplied anymore — it's derived
  // automatically server-side from the gym's registered sensor count
  // (see SessionsService.create). Kept here only so an older client
  // build that still sends the field doesn't fail validation; the
  // value itself is always ignored.
  @IsOptional() @IsInt() @Min(1) capacity?: number;
  @IsOptional() @IsDateString() scheduledAt?: string;
  // Planning-only end time — see Session.scheduledEndAt comment in the
  // schema. Purely for the calendar view; the live session's actual end
  // is still whatever the trainer sets when they end it.
  @IsOptional() @IsDateString() scheduledEndAt?: string;
  // Branch Portal lets a front-desk manager assign ANY active trainer
  // at their gym, not just themselves. The Trainer App never sends
  // this — a trainer scheduling their own session defaults to
  // themselves (see SessionsService.create).
  @IsOptional() @IsString() trainerId?: string;
}

export class EnrollMemberDto {
  @IsString() memberId!: string;
}

export class CancelSessionDto {
  @IsOptional() @IsString() reason?: string;
}

export class SetAttendanceDto {
  @IsString() memberId!: string;
  @IsIn(['enrolled', 'attended', 'no_show']) attendance!: 'enrolled' | 'attended' | 'no_show';
}

export class SessionResultDto {
  @IsString() memberId!: string;
  @IsOptional() @IsInt() avgHr?: number;
  @IsOptional() @IsInt() maxHr?: number;
  @IsOptional() @IsNumber() calories?: number;
  @IsOptional() @IsObject() zoneMinutes?: Record<string, number>;
  @IsOptional() @IsNumber() score?: number;

  // Rich post-workout summary fields (spec §7) — optional so a client
  // that ends a session with only the core aggregates still works.
  @IsOptional() @IsNumber() sweatPoints?: number;
  @IsOptional() @IsNumber() recoveryPoints?: number;
  @IsOptional() @IsString() recoveryGrade?: string;
  @IsOptional() @IsNumber() epocCalories?: number;
  @IsOptional() @IsNumber() epocHours?: number;
  @IsOptional() @IsNumber() avgPctMhr?: number;
  @IsOptional() @IsNumber() maxPctMhr?: number;
  @IsOptional() @IsInt() finalRank?: number;
  @IsOptional() @IsNumber() consistencyPct?: number;
}

export class EndSessionDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SessionResultDto)
  results!: SessionResultDto[];
}

export class SensorReadingDto {
  @IsString() memberId!: string;
  @IsDateString() ts!: string;
  @IsInt() hr!: number;
  @IsOptional() @IsInt() rrMs?: number;
  // True when the Trainer App's sensor watchdog synthesized this
  // reading during a >15s dropout rather than reading it off the
  // sensor (see uvactive-trainer-app's sensorWatchdog.ts). Stored for
  // ops/QA auditability only — nothing in any portal's member- or
  // trainer-facing UI should ever branch on or display this field.
  @IsOptional() @IsBoolean() interpolated?: boolean;
}

export class IngestSensorReadingsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SensorReadingDto)
  readings!: SensorReadingDto[];
}
