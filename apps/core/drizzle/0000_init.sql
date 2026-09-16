CREATE TABLE `anchors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`head_seq` integer NOT NULL,
	`head_hash` text NOT NULL,
	`proof` text NOT NULL,
	`submitted_at` text NOT NULL,
	`confirmed_at` text,
	`block_height` integer
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`action` text NOT NULL,
	`requested_at` text NOT NULL,
	`decided_at` text,
	`decision` text,
	`decided_by` text
);
--> statement-breakpoint
CREATE TABLE `calls` (
	`sid` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`direction` text NOT NULL,
	`role` text NOT NULL,
	`party_label` text NOT NULL,
	`to_masked` text,
	`from_masked` text,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`ack_at` text,
	`recording_url` text,
	`test` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`geometry` text NOT NULL,
	`severity` text NOT NULL,
	`sources` text NOT NULL,
	`detected_at` text NOT NULL,
	`ingested_at` text NOT NULL,
	`tier` integer NOT NULL,
	`status` text NOT NULL,
	`is_drill` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `facts` (
	`id` text NOT NULL,
	`run_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`value` text NOT NULL,
	`unit` text NOT NULL,
	`display` text NOT NULL,
	`spoken` text NOT NULL,
	`tolerance` text NOT NULL,
	`source` text NOT NULL,
	`supersedes` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `facts_key` ON `facts` (`run_id`,`key`);--> statement-breakpoint
CREATE TABLE `grades` (
	`run_id` text PRIMARY KEY NOT NULL,
	`truth` text NOT NULL,
	`score` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hospital_fields` (
	`ccn` text NOT NULL,
	`field` text NOT NULL,
	`value` text,
	`source_name` text NOT NULL,
	`source_url` text,
	`confidence` real NOT NULL,
	`retrieved_at` text NOT NULL,
	PRIMARY KEY(`ccn`, `field`, `source_name`)
);
--> statement-breakpoint
CREATE TABLE `hospitals` (
	`ccn` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`city` text,
	`state` text,
	`zip` text,
	`lat` real,
	`lon` real,
	`phone_main` text,
	`phone_er` text,
	`er_hours` text,
	`has_ed` integer,
	`trauma_level` text,
	`beds` integer,
	`certified_beds` integer,
	`website` text,
	`overflow_ccn` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`run_id` text,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `log_hash_unique` ON `log` (`hash`);--> statement-breakpoint
CREATE INDEX `log_run` ON `log` (`run_id`);--> statement-breakpoint
CREATE INDEX `log_kind` ON `log` (`kind`);--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`model` text NOT NULL,
	`version` text NOT NULL,
	`inputs` text NOT NULL,
	`outputs` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`mode` text NOT NULL,
	`as_of` text,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE TABLE `whitelist` (
	`e164` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`role` text NOT NULL,
	`consent_at` text NOT NULL,
	`consent_by` text NOT NULL
);
