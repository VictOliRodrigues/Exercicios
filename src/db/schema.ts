import {
  boolean,
  char,
  datetime,
  decimal,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';

// Colunas *_enc guardam texto criptografado (base64); *_idx guardam índices de busca.
// Todas as datas são gravadas em UTC.

const uuid = (name: string) => char(name, { length: 36 });

export const users = mysqlTable('users', {
  id: uuid('id').primaryKey(),
  emailIdx: char('email_idx', { length: 64 }).notNull().unique(),
  emailEnc: text('email_enc').notNull(),
  nameEnc: text('name_enc').notNull(),
  phoneEnc: text('phone_enc'),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: mysqlEnum('role', ['admin', 'user']).notNull(),
  active: boolean('active').notNull().default(true),
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  passwordResetRequestedAt: datetime('password_reset_requested_at'),
  sessionVersion: int('session_version').notNull().default(1),
  failedLogins: int('failed_logins').notNull().default(0),
  lockedUntil: datetime('locked_until'),
  lastLoginAt: datetime('last_login_at'),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
});

export const studyGroups = mysqlTable('study_groups', {
  id: uuid('id').primaryKey(),
  nameEnc: text('name_enc').notNull(),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
  deletedAt: datetime('deleted_at'),
});

export const studyGroupMembers = mysqlTable(
  'study_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => studyGroups.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    addedAt: datetime('added_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index('study_group_members_user_idx').on(table.userId),
  ],
);

export const questionBanks = mysqlTable(
  'question_banks',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    titleEnc: text('title_enc').notNull(),
    originalNameEnc: text('original_name_enc').notNull(),
    storageKey: uuid('storage_key').notNull(),
    questionCount: int('question_count').notNull(),
    createdAt: datetime('created_at').notNull(),
    updatedAt: datetime('updated_at').notNull(),
    deletedAt: datetime('deleted_at'),
  },
  (table) => [index('question_banks_user_idx').on(table.userId)],
);

export const questionBankGroups = mysqlTable(
  'question_bank_groups',
  {
    bankId: uuid('bank_id')
      .notNull()
      .references(() => questionBanks.id),
    groupId: uuid('group_id')
      .notNull()
      .references(() => studyGroups.id),
    sharedAt: datetime('shared_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bankId, table.groupId] }),
    index('question_bank_groups_group_idx').on(table.groupId),
  ],
);

export const questions = mysqlTable(
  'questions',
  {
    id: uuid('id').primaryKey(),
    bankId: uuid('bank_id')
      .notNull()
      .references(() => questionBanks.id),
    position: int('position').notNull(),
    payloadEnc: mediumtext('payload_enc').notNull(),
  },
  (table) => [index('questions_bank_idx').on(table.bankId, table.position)],
);

export const attempts = mysqlTable(
  'attempts',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    bankId: uuid('bank_id')
      .notNull()
      .references(() => questionBanks.id),
    status: mysqlEnum('status', ['in_progress', 'finished']).notNull(),
    totalQuestions: int('total_questions').notNull(),
    timeLimitSeconds: int('time_limit_seconds'),
    startedAt: datetime('started_at', { fsp: 3 }).notNull(),
    deadlineAt: datetime('deadline_at', { fsp: 3 }),
    finishedAt: datetime('finished_at', { fsp: 3 }),
    finishReason: mysqlEnum('finish_reason', ['user', 'time']),
    durationSeconds: int('duration_seconds'),
    correctCount: int('correct_count'),
    wrongCount: int('wrong_count'),
    blankCount: int('blank_count'),
    score: decimal('score', { precision: 4, scale: 2 }),
  },
  (table) => [
    index('attempts_user_status_idx').on(table.userId, table.status),
    index('attempts_user_bank_idx').on(table.userId, table.bankId),
  ],
);

export const attemptQuestions = mysqlTable(
  'attempt_questions',
  {
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id),
    number: int('number').notNull(),
    page: int('page').notNull(),
    sort: int('sort').notNull(),
    optionOrder: json('option_order').$type<number[]>().notNull(),
    selectedOption: tinyint('selected_option'),
    isCorrect: boolean('is_correct'),
    answeredAt: datetime('answered_at', { fsp: 3 }),
  },
  (table) => [
    primaryKey({ columns: [table.attemptId, table.questionId] }),
    index('attempt_questions_page_idx').on(table.attemptId, table.page, table.sort),
  ],
);

export type UserRow = typeof users.$inferSelect;
