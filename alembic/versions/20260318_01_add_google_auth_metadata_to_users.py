"""Add Google auth metadata columns to users.

Revision ID: 20260318_01
Revises: 20260227_02
Create Date: 2026-03-18 12:30:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "20260318_01"
down_revision: Union[str, Sequence[str], None] = "20260227_02"
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
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(32)
        """
    )
    op.execute(
        """
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS provider_user_id VARCHAR(255)
        """
    )
    op.execute(
        """
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS provider_email VARCHAR(255)
        """
    )
    op.execute(
        """
        UPDATE users
           SET auth_provider = 'email'
         WHERE auth_provider IS NULL
        """
    )
    op.execute(
        """
        ALTER TABLE users
            ALTER COLUMN auth_provider SET DEFAULT 'email'
        """
    )
    op.execute(
        """
        ALTER TABLE users
            ALTER COLUMN auth_provider SET NOT NULL
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_users_provider_identity
            ON users (auth_provider, provider_user_id)
            WHERE provider_user_id IS NOT NULL
        """
    )


def downgrade() -> None:
    if "users" not in _existing_tables():
        return

    op.execute("DROP INDEX IF EXISTS uq_users_provider_identity")
    op.execute(
        """
        ALTER TABLE users
            DROP COLUMN IF EXISTS provider_email
        """
    )
    op.execute(
        """
        ALTER TABLE users
            DROP COLUMN IF EXISTS provider_user_id
        """
    )
    op.execute(
        """
        ALTER TABLE users
            DROP COLUMN IF EXISTS auth_provider
        """
    )
