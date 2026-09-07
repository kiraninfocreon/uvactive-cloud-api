import { IsEmail, IsOptional, IsString } from 'class-validator';

// No `role` field here on purpose. A branch manager is created exactly
// once, alongside its Gym (GymsService.create, isPrimaryManager=true) —
// never through this endpoint. Every trainer this DTO creates is
// role='trainer', hardcoded in TrainersService.create, closing the bug
// where a branch could self-provision another branch_manager account.
export class CreateTrainerDto {
  @IsString() name!: string;
  @IsEmail() email!: string;
  @IsString() phone!: string;
}

export class UpdateTrainerDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() photoUrl?: string;
}
