CREATE TABLE `folder_banks` (
	`user_id` char(36) NOT NULL,
	`bank_id` char(36) NOT NULL,
	`folder_id` char(36) NOT NULL,
	`added_at` datetime NOT NULL,
	CONSTRAINT `folder_banks_user_id_bank_id_pk` PRIMARY KEY(`user_id`,`bank_id`)
);
--> statement-breakpoint
CREATE TABLE `folders` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`name_enc` text NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `folders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `folder_banks` ADD CONSTRAINT `folder_banks_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `folder_banks` ADD CONSTRAINT `folder_banks_bank_id_question_banks_id_fk` FOREIGN KEY (`bank_id`) REFERENCES `question_banks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `folder_banks` ADD CONSTRAINT `folder_banks_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `folders` ADD CONSTRAINT `folders_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `folder_banks_folder_idx` ON `folder_banks` (`folder_id`);--> statement-breakpoint
CREATE INDEX `folders_user_idx` ON `folders` (`user_id`);