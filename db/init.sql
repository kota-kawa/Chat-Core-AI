-- usersテーブル
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    email       VARCHAR(255)    NOT NULL UNIQUE,
    username    VARCHAR(255)    NOT NULL DEFAULT 'ユーザー',
    bio         TEXT            NULL,
    avatar_url  VARCHAR(255)    NOT NULL DEFAULT '/static/user-icon.png',
    is_verified BOOLEAN         DEFAULT FALSE,
    auth_provider VARCHAR(32)   NOT NULL DEFAULT 'email',
    provider_user_id VARCHAR(255) NULL,
    provider_email VARCHAR(255) NULL,
    created_at  TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_provider_identity
    ON users (auth_provider, provider_user_id)
    WHERE provider_user_id IS NOT NULL;

-- chat_roomsテーブル
CREATE TABLE chat_rooms (
    id VARCHAR(255) PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(255) DEFAULT '新規チャット',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_chat_rooms_user_created_at
    ON chat_rooms (user_id, created_at DESC);

-- chat_historyテーブル
CREATE TABLE chat_history (
    id SERIAL PRIMARY KEY,
    chat_room_id VARCHAR(255) NOT NULL,
    message TEXT,
    sender VARCHAR(20) CHECK (sender IN ('user','assistant')),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_chat_history_room
        FOREIGN KEY (chat_room_id)
        REFERENCES chat_rooms(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_history_room_id_id
    ON chat_history (chat_room_id, id);

-- 個人ユーザーが管理するプロンプトとfew shot
CREATE TABLE task_with_examples (
  id SERIAL PRIMARY KEY,
  -- 追加: タスクの所有ユーザー
  user_id INT NULL,
  name VARCHAR(255) NOT NULL,
  prompt_template TEXT NOT NULL,
  input_examples TEXT,
  output_examples TEXT,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- 外部キー制約
  CONSTRAINT fk_task_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_with_examples_user_name
    ON task_with_examples (user_id, name);

CREATE INDEX IF NOT EXISTS idx_task_with_examples_user_order
    ON task_with_examples (user_id, display_order, id);

CREATE INDEX IF NOT EXISTS idx_task_with_examples_user_created_at
    ON task_with_examples (user_id, created_at DESC, id DESC);

-- プロンプト共有のためのテーブル
CREATE TABLE IF NOT EXISTS prompts (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,  -- ユーザーIDを追加
    is_public BOOLEAN NOT NULL DEFAULT FALSE,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    author VARCHAR(50) NOT NULL,
    input_examples TEXT,
    output_examples TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_prompts_public_created_at
    ON prompts (is_public, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_user_created_at
    ON prompts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_public_title_trgm
    ON prompts USING gin (title gin_trgm_ops)
    WHERE is_public = TRUE;

CREATE INDEX IF NOT EXISTS idx_prompts_public_content_trgm
    ON prompts USING gin (content gin_trgm_ops)
    WHERE is_public = TRUE;

CREATE INDEX IF NOT EXISTS idx_prompts_public_category_trgm
    ON prompts USING gin (category gin_trgm_ops)
    WHERE is_public = TRUE;

CREATE INDEX IF NOT EXISTS idx_prompts_public_author_trgm
    ON prompts USING gin (author gin_trgm_ops)
    WHERE is_public = TRUE;

-- プロンプトリストを管理するテーブル
CREATE TABLE IF NOT EXISTS prompt_list_entries (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    prompt_id INT NULL,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(50) DEFAULT '',
    content TEXT NOT NULL,
    input_examples TEXT,
    output_examples TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, prompt_id),
    CONSTRAINT fk_prompt_list_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_prompt_list_prompt
        FOREIGN KEY (prompt_id)
        REFERENCES prompts(id)
        ON DELETE SET NULL
);

CREATE INDEX idx_prompt_list_user_title
    ON prompt_list_entries (user_id, title);

CREATE INDEX IF NOT EXISTS idx_prompt_list_user_created_at
    ON prompt_list_entries (user_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_list_user_title_when_prompt_null
    ON prompt_list_entries (user_id, title)
    WHERE prompt_id IS NULL;

-- AIメモを保存するためのテーブル
CREATE TABLE IF NOT EXISTS memo_entries (
    id SERIAL PRIMARY KEY,
    user_id INT NULL,
    input_content TEXT NOT NULL,
    ai_response TEXT NOT NULL,
    title VARCHAR(255) NOT NULL,
    tags VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_memo_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memo_entries_created_at
    ON memo_entries (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memo_entries_user_created_at
    ON memo_entries (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_task_with_examples_updated_at
BEFORE UPDATE ON task_with_examples
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_memo_entries_updated_at
BEFORE UPDATE ON memo_entries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- 既定タスクは frontend/data/default_tasks.json を単一ソースとして
-- アプリ起動時（services.default_tasks.ensure_default_tasks_seeded）に投入する。
