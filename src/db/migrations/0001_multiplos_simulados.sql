CREATE TABLE `attempt_banks` (
	`attempt_id` char(36) NOT NULL,
	`bank_id` char(36) NOT NULL,
	`position` int NOT NULL,
	CONSTRAINT `attempt_banks_attempt_id_bank_id_pk` PRIMARY KEY(`attempt_id`,`bank_id`)
);
--> statement-breakpoint
ALTER TABLE `attempts` MODIFY COLUMN `bank_id` char(36);--> statement-breakpoint
ALTER TABLE `attempt_banks` ADD CONSTRAINT `attempt_banks_attempt_id_attempts_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attempt_banks` ADD CONSTRAINT `attempt_banks_bank_id_question_banks_id_fk` FOREIGN KEY (`bank_id`) REFERENCES `question_banks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `attempt_banks_bank_idx` ON `attempt_banks` (`bank_id`);--> statement-breakpoint
-- As tentativas que já existem têm um simulado só.
INSERT INTO `attempt_banks` (`attempt_id`, `bank_id`, `position`) SELECT `id`, `bank_id`, 1 FROM `attempts`;
