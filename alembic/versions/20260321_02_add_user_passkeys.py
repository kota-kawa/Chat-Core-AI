"""Add user_passkeys table for WebAuthn credentials.

Revision ID: 20260321_02
Revises: 20260321_01
Create Date: 2026-03-21 15:00:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "20260321_02"
down_revision: Union[str, Sequence[str], None] = "20260321_01"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _existing_tables() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return set(inspector.get_table_names())


def upgrade() -> None:
    if "users" not in _existing_tables():
        return

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_passkeys (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL,
            credential_id VARCHAR(255) NOT NULL UNIQUE,
            public_key TEXT NOT NULL,
            sign_count BIGINT NOT NULL DEFAULT 0,
            aaguid VARCHAR(64) NULL,
            credential_device_type VARCHAR(32) NULL,
            credential_backed_up BOOLEAN NOT NULL DEFAULT FALSE,
            label VARCHAR(255) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_used_at TIMESTAMP NULL,
            CONSTRAINT fk_user_passkeys_user
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_created_at
            ON user_passkeys (user_id, created_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_user_passkeys_user_created_at")
    op.execute("DROP TABLE IF EXISTS user_passkeys")
