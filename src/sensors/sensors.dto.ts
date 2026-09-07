import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateSensorDto {
  @IsString() name!: string;
  @IsString() sensorId!: string;
  @IsOptional() @IsString() note?: string;
}

export class UpdateSensorDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() sensorId?: string;
  @IsOptional() @IsString() note?: string;
}

export class UpsertTelemetryDto {
  @IsOptional() @IsInt() @Min(0) @Max(100) batteryPct?: number;
  @IsIn(['connected', 'reconnecting', 'disconnected']) connectionState!: 'connected' | 'reconnecting' | 'disconnected';
  @IsOptional() @IsString() sessionId?: string;
}
