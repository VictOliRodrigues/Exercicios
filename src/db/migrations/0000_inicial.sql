CREATE TABLE `attempt_questions` (
	`attempt_id` char(36) NOT NULL,
	`question_id` char(36) NOT NULL,
	`number` int NOT NULL,
	`page` int NOT NULL,
	`sort` int NOT NULL,
	`option_order` json NOT NULL,
	`selected_option` tinyint,
	`is_correct` boolean,
	`answered_at` datetime(3),
	CONSTRAINT `attempt_questions_attempt_id_question_id_pk` PRIMARY KEY(`attempt_id`,`question_id`)
);
--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`bank_id` char(36) NOT NULL,
	`status` enum('in_progress','finished') NOT NULL,
	`total_questions` int NOT NULL,
	`time_limit_seconds` int,
	`started_at` datetime(3) NOT NULL,
	`deadline_at` datetime(3),
	`finished_at` datetime(3),
	`finish_reason` enum('user','time'),
	`duration_seconds` int,
	`correct_count` int,
	`wrong_count` int,
	`blank_count` int,
	`score` decimal(4,2),
	CONSTRAINT `attempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `question_bank_groups` (
	`bank_id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`shared_at` datetime NOT NULL,
	CONSTRAINT `question_bank_groups_bank_id_group_id_pk` PRIMARY KEY(`bank_id`,`group_id`)
);
--> statement-breakpoint
CREATE TABLE `question_banks` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`title_enc` text NOT NULL,
	`original_name_enc` text NOT NULL,
	`storage_key` char(36) NOT NULL,
	`question_count` int NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	`deleted_at` datetime,
	CONSTRAINT `question_banks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` char(36) NOT NULL,
	`bank_id` char(36) NOT NULL,
	`position` int NOT NULL,
	`payload_enc` mediumtext NOT NULL,
	CONSTRAINT `questions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `study_group_members` (
	`group_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`added_at` datetime NOT NULL,
	CONSTRAINT `study_group_members_group_id_user_id_pk` PRIMARY KEY(`group_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `study_groups` (
	`id` char(36) NOT NULL,
	`name_enc` text NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	`deleted_at` datetime,
	CONSTRAINT `study_groups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`email_idx` char(64) NOT NULL,
	`email_enc` text NOT NULL,
	`name_enc` text NOT NULL,
	`phone_enc` text,
	`password_hash` varchar(255) NOT NULL,
	`role` enum('admin','user') NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`must_change_password` boolean NOT NULL DEFAULT true,
	`password_reset_requested_at` datetime,
	`session_version` int NOT NULL DEFAULT 1,
	`failed_logins` int NOT NULL DEFAULT 0,
	`locked_until` datetime,
	`last_login_at` datetime,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_idx_unique` UNIQUE(`email_idx`)
);
--> statement-breakpoint
ALTER TABLE `attempt_questions` ADD CONSTRAINT `attempt_questions_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attempt_questions` ADD CONSTRAINT `attempt_questions_question_id_questions_id_fk` FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attempts` ADD CONSTRAINT `attempts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attempts` ADD CONSTRAINT `attempts_bank_id_question_banks_id_fk` FOREIGN KEY (`bank_id`) REFERENCES `question_banks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `question_bank_groups` ADD CONSTRAINT `question_bank_groups_bank_id_question_banks_id_fk` FOREIGN KEY (`bank_id`) REFERENCES `question_banks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `question_bank_groups` ADD CONSTRAINT `question_bank_groups_group_id_study_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `study_groups`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `question_banks` ADD CONSTRAINT `question_banks_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `questions` ADD CONSTRAINT `questions_bank_id_question_banks_id_fk` FOREIGN KEY (`bank_id`) REFERENCES `question_banks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `study_group_members` ADD CONSTRAINT `study_group_members_group_id_study_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `study_groups`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `study_group_members` ADD CONSTRAINT `study_group_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `attempt_questions_page_idx` ON `attempt_questions` (`attempt_id`,`page`,`sort`);--> statement-breakpoint
CREATE INDEX `attempts_user_status_idx` ON `attempts` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `attempts_user_bank_idx` ON `attempts` (`user_id`,`bank_id`);--> statement-breakpoint
CREATE INDEX `question_bank_groups_group_idx` ON `question_bank_groups` (`group_id`);--> statement-breakpoint
CREATE INDEX `question_banks_user_idx` ON `question_banks` (`user_id`);--> statement-breakpoint
CREATE INDEX `questions_bank_idx` ON `questions` (`bank_id`,`position`);--> statement-breakpoint
CREATE INDEX `study_group_members_user_idx` ON `study_group_members` (`user_id`);