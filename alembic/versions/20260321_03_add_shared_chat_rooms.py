"""Add shared chat room links table.

Revision ID: 20260321_03
Revises: 20260321_02
Create Date: 2026-03-21 16:00:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "20260321_03"
down_revision: Union[str, Sequence[str], None] = "20260321_02"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _existing_tables() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return set(inspector.get_table_names())


def upgrade() -> None:
    tables = _existing_tables()
    if "chat_rooms" not in tables:
        return

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS shared_chat_rooms (
            id SERIAL PRIMARY KEY,
            chat_room_id VARCHAR(255) NOT NULL UNIQUE,
            share_token VARCHAR(128) NOT NULL UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_shared_chat_rooms_room
                FOREIGN KEY (chat_room_id)
                REFERENCES chat_rooms(id)
                ON DELETE CASCADE
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shared_chat_rooms_token_created_at
            ON shared_chat_rooms (share_token, created_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_shared_chat_rooms_token_created_at")
    op.execute("DROP TABLE IF EXISTS shared_chat_rooms")
