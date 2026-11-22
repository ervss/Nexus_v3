"""add persistent PornHub discovery queue

Revision ID: f71b2c0d4e01
Revises: 97f4b0311c75
Create Date: 2026-07-13
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f71b2c0d4e01"
down_revision: Union[str, Sequence[str], None] = "97f4b0311c75"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pornhub_queue_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("url", sa.String(), nullable=False),
        sa.Column("source_url", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("thumbnail", sa.String(), nullable=True),
        sa.Column("duration", sa.Float(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("file_size_mb", sa.Float(), nullable=True),
        sa.Column("upload_date", sa.String(), nullable=True),
        sa.Column("tags", sa.String(), nullable=True),
        sa.Column("query", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("duplicate_video_id", sa.Integer(), nullable=True),
        sa.Column("import_job_id", sa.Integer(), nullable=True),
        sa.Column("import_job_item_id", sa.Integer(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("added_at", sa.DateTime(), nullable=True),
        sa.Column("analyzed_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("pornhub_queue_items") as batch_op:
        batch_op.create_index(batch_op.f("ix_pornhub_queue_items_id"), ["id"], unique=False)
        batch_op.create_index(batch_op.f("ix_pornhub_queue_items_url"), ["url"], unique=True)
        batch_op.create_index(batch_op.f("ix_pornhub_queue_items_source_url"), ["source_url"], unique=False)
        batch_op.create_index(batch_op.f("ix_pornhub_queue_items_status"), ["status"], unique=False)
        batch_op.create_index(batch_op.f("ix_pornhub_queue_items_import_job_id"), ["import_job_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_pornhub_queue_items_import_job_item_id"), ["import_job_item_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_pornhub_queue_items_added_at"), ["added_at"], unique=False)


def downgrade() -> None:
    op.drop_table("pornhub_queue_items")
