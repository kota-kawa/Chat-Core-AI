import inspect
import logging
import os
from functools import wraps
from typing import Optional
from urllib.parse import urlencode

from fastapi import Request
from starlette.responses import RedirectResponse

from services.async_utils import run_blocking
from services.db import Error, get_db_connection
from services.security import verify_password
from services.web import (
    flash,
    frontend_url,
    get_flashed_messages,
    get_json,
    jsonify,
    log_and_internal_server_error,
    redirect_to_frontend,
    sanitize_next_path,
    url_for,
)

from . import admin_bp

try:
    from psycopg2 import sql as pg_sql
except ModuleNotFoundError:  # pragma: no cover - optional for test envs
    pg_sql = None

ADMIN_PASSWORD_HASH = (os.getenv("ADMIN_PASSWORD_HASH") or "").strip()
logger = logging.getLogger(__name__)


def _verify_admin_password(password: str) -> bool:
    if not ADMIN_PASSWORD_HASH:
        return False
    return verify_password(password, ADMIN_PASSWORD_HASH)


def _require_pg_sql():
    if pg_sql is None:  # pragma: no cover - depends on optional dependency
        raise RuntimeError("psycopg2 is required for admin SQL composition.")
    return pg_sql


def _sql_identifier(name: str):
    return _require_pg_sql().Identifier(name)


def _normalize_fragment(fragment: str) -> str:
    return fragment.rstrip(";").strip()


def _has_multiple_statements(fragment: str) -> bool:
    return ";" in fragment


def frontend_admin_dashboard_url(request: Request, **params) -> str:
    return frontend_url(url_for(request, "admin.dashboard", **params))


def admin_required(view_func):
    @wraps(view_func)
    async def wrapper(*args, **kwargs):
        request = kwargs.get("request")
        if request is None:
            for arg in args:
                if isinstance(arg, Request):
                    request = arg
                    break
        if request is None:
            raise RuntimeError("Request is required for admin routes")

        if not request.session.get("is_admin"):
            next_path = request.url.path
            if request.url.query:
                next_path = f"{next_path}?{request.url.query}"
            login_url = frontend_url(
                "/admin/login", query=urlencode({"next": next_path})
            )
            return RedirectResponse(login_url, status_code=302)

        if inspect.iscoroutinefunction(view_func):
            return await view_func(*args, **kwargs)
        return view_func(*args, **kwargs)

    return wrapper


def _admin_guard(request: Request):
    if not request.session.get("is_admin"):
        return jsonify({"status": "fail", "error": "Unauthorized"}, status_code=401)
    return None


async def _get_payload(request: Request) -> dict:
    data = await get_json(request)
    if data is not None:
        return data
    form = await request.form()
    return {key: value for key, value in form.items()}


@admin_bp.api_route("/login", methods=["GET", "POST"], name="admin.login")
async def login(request: Request):
    status_code = 302 if request.method == "GET" else 303
    return redirect_to_frontend(request, path="/admin/login", status_code=status_code)


@admin_bp.post("/api/login", name="admin.api_login")
async def api_login(request: Request):
    payload = await _get_payload(request)
    password = payload.get("password") or ""
    next_url = sanitize_next_path(payload.get("next"), default="/admin")

    if _verify_admin_password(password):
        request.session["is_admin"] = True
        flash(request, "Logged in as administrator.", "success")
        redirect_url = frontend_url(next_url)
        return jsonify({"status": "success", "redirect": redirect_url})

    return jsonify({"status": "fail", "error": "Invalid password."}, status_code=401)


@admin_bp.post("/api/logout", name="admin.api_logout")
async def api_logout(request: Request):
    request.session.pop("is_admin", None)
    flash(request, "Logged out of administrator session.", "success")
    return jsonify(
        {"status": "success", "redirect": frontend_url("/admin/login")}
    )


@admin_bp.get("/logout", name="admin.logout")
@admin_required
async def logout(request: Request):
    request.session.pop("is_admin", None)
    flash(request, "Logged out of administrator session.", "success")
    return RedirectResponse(frontend_url("/admin/login"), status_code=302)


def _fetch_tables(cursor) -> list[str]:
    cursor.execute(
        """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
        """
    )
    return [row[0] for row in cursor.fetchall()]


def _fetch_table_columns(cursor, table_name: str) -> list[dict[str, object]]:
    cursor.execute(
        """
        SELECT
            attr.attname AS column_name,
            pg_catalog.format_type(attr.atttypid, attr.atttypmod) AS column_type,
            NOT attr.attnotnull AS is_nullable,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_index idx
                    WHERE idx.indrelid = rel.oid
                      AND idx.indisprimary
                      AND attr.attnum = ANY(idx.indkey)
                ) THEN 'PRI'
                WHEN EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_index idx
                    WHERE idx.indrelid = rel.oid
                      AND idx.indisunique
                      AND attr.attnum = ANY(idx.indkey)
                ) THEN 'UNI'
                WHEN EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_index idx
                    WHERE idx.indrelid = rel.oid
                      AND NOT idx.indisunique
                      AND attr.attnum = ANY(idx.indkey)
                ) THEN 'MUL'
                ELSE ''
            END AS column_key,
            pg_catalog.pg_get_expr(def.adbin, def.adrelid) AS column_default,
            CASE
                WHEN attr.attidentity IN ('a', 'd')
                     OR pg_catalog.pg_get_expr(def.adbin, def.adrelid) LIKE 'nextval(%'
                THEN 'auto_increment'
                ELSE ''
            END AS extra
        FROM pg_catalog.pg_attribute attr
        JOIN pg_catalog.pg_class rel
          ON rel.oid = attr.attrelid
        JOIN pg_catalog.pg_namespace nsp
          ON nsp.oid = rel.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef def
          ON def.adrelid = attr.attrelid
         AND def.adnum = attr.attnum
        WHERE nsp.nspname = current_schema()
          AND rel.relname = %s
          AND attr.attnum > 0
          AND NOT attr.attisdropped
        ORDER BY attr.attnum
        """,
        (table_name,),
    )
    columns: list[dict[str, object]] = []
    for row in cursor.fetchall():
        columns.append(
            {
                "name": row[0],
                "type": row[1],
                "nullable": bool(row[2]),
                "key": row[3],
                "default": row[4],
                "extra": row[5],
            }
        )
    return columns


def _fetch_table_preview(cursor, table_name: str) -> tuple[list[str], list[tuple]]:
    psql = _require_pg_sql()
    cursor.execute(
        psql.SQL("SELECT * FROM {} LIMIT 100").format(_sql_identifier(table_name))
    )
    rows = cursor.fetchall()
    column_names = [desc[0] for desc in cursor.description]
    return column_names, rows


def _build_create_table_sql(
    table_name: str, column_definitions: str, table_options: str = ""
):
    psql = _require_pg_sql()
    statement = psql.SQL("CREATE TABLE {} ({})").format(
        _sql_identifier(table_name), psql.SQL(column_definitions)
    )
    if table_options:
        statement = statement + psql.SQL(" ") + psql.SQL(table_options)
    return statement


def _build_drop_table_sql(table_name: str):
    psql = _require_pg_sql()
    return psql.SQL("DROP TABLE {}").format(_sql_identifier(table_name))


def _build_add_column_sql(table_name: str, column_name: str, column_type: str):
    psql = _require_pg_sql()
    return psql.SQL("ALTER TABLE {} ADD COLUMN {} {}").format(
        _sql_identifier(table_name),
        _sql_identifier(column_name),
        psql.SQL(column_type),
    )


def _build_drop_column_sql(table_name: str, column_name: str):
    psql = _require_pg_sql()
    return psql.SQL("ALTER TABLE {} DROP COLUMN {}").format(
        _sql_identifier(table_name), _sql_identifier(column_name)
    )


def _load_dashboard_data(selected_table: Optional[str]) -> dict:
    connection = None
    cursor = None
    try:
        connection = get_db_connection()
        cursor = connection.cursor()
        tables = _fetch_tables(cursor)
        column_names: list[str] = []
        column_details: list[dict[str, object]] = []
        existing_columns: list[str] = []
        rows: list[tuple] = []
        missing_selected_table = False

        if selected_table:
            if selected_table in tables:
                column_names, rows = _fetch_table_preview(cursor, selected_table)
                column_details = _fetch_table_columns(cursor, selected_table)
                existing_columns = [column["name"] for column in column_details]
            else:
                missing_selected_table = True
                selected_table = None

        return {
            "tables": tables,
            "selected_table": selected_table,
            "column_names": column_names,
            "column_details": column_details,
            "existing_columns": existing_columns,
            "rows": rows,
            "missing_selected_table": missing_selected_table,
        }
    finally:
        if cursor is not None:
            cursor.close()
        if connection is not None:
            connection.close()


def _create_table_in_db(table_name: str, column_definitions: str, table_options: str) -> None:
    connection = None
    cursor = None
    try:
        connection = get_db_connection()
        cursor = connection.cursor()
        cursor.execute(_build_create_table_sql(table_name, column_definitions, table_options))
        connection.commit()
    finally:
        if cursor is not None:
            cursor.close()
        if connection is not None:
            connection.close()


def _drop_table_if_exists(table_name: str) -> bool:
    connection = None
    cursor = None
    try:
        connection = get_db_connection()
        cursor = connection.cursor()
        existing_tables = _fetch_tables(cursor)
        if table_name not in existing_tables:
            return False
        cursor.execute(_build_drop_table_sql(table_name))
        connection.commit()
        return True
    finally:
        if cursor is not None:
            cursor.close()
        if connection is not None:
            connection.close()


def _add_column_if_valid(table_name: str, column_name: str, column_type: str) -> str:
    connection = None
    cursor = None
    try:
        connection = get_db_connection()
        cursor = connection.cursor()
        tables = _fetch_tables(cursor)
        if table_name not in tables:
            return "missing_table"

        existing_columns = [column["name"] for column in _fetch_table_columns(cursor, table_name)]
        normalized_existing_columns = {name.lower() for name in existing_columns}
        if column_name.lower() in normalized_existing_columns:
            return "duplicate_column"

        cursor.execute(_build_add_column_sql(table_name, column_name, column_type))
        connection.commit()
        return "ok"
    finally:
        if cursor is not None:
            cursor.close()
        if connection is not None:
            connection.close()


def _drop_column_if_valid(table_name: str, column_name: str) -> tuple[str, Optional[str]]:
    connection = None
    cursor = None
    try:
        connection = get_db_connection()
        cursor = connection.cursor()
        tables = _fetch_tables(cursor)
        if table_name not in tables:
            return "missing_table", None

        columns = _fetch_table_columns(cursor, table_name)
        existing_columns = [column["name"] for column in columns]
        column_lookup = {name.lower(): name for name in existing_columns}
        target_column = column_lookup.get(column_name.lower())
        if target_column is None:
            return "missing_column", None

        if len(existing_columns) <= 1:
            return "last_column", None

        cursor.execute(_build_drop_column_sql(table_name, target_column))
        connection.commit()
        return "ok", target_column
    finally:
        if cursor is not None:
            cursor.close()
        if connection is not None:
            connection.close()


@admin_bp.get("/", name="admin.dashboard")
@admin_required
async def dashboard(request: Request):
    return redirect_to_frontend(request)


@admin_bp.get("/api/dashboard", name="admin.api_dashboard")
async def api_dashboard(request: Request):
    guard = _admin_guard(request)
    if guard is not None:
        return guard

    selected_table: Optional[str] = request.query_params.get("table")
    tables: list[str] = []
    column_names: list[str] = []
    column_details: list[dict[str, object]] = []
    existing_columns: list[str] = []
    rows: list[tuple] = []
    error: Optional[str] = None

    try:
        dashboard_data = await run_blocking(_load_dashboard_data, selected_table)
        tables = dashboard_data["tables"]
        selected_table = dashboard_data["selected_table"]
        column_names = dashboard_data["column_names"]
        column_details = dashboard_data["column_details"]
        existing_columns = dashboard_data["existing_columns"]
        rows = dashboard_data["rows"]
        if dashboard_data["missing_selected_table"]:
            flash(request, "The selected table does not exist.", "error")
    except Error:  # pragma: no cover - defensive logging
        logger.exception("Failed to load admin dashboard data.")
        error = "ダッシュボード情報の取得に失敗しました。"

    messages = get_flashed_messages(request, with_categories=True)

    return jsonify(
        {
            "tables": tables,
            "selected_table": selected_table,
            "column_names": column_names,
            "column_details": column_details,
            "existing_columns": existing_columns,
            "rows": rows,
            "error": error,
            "messages": messages,
        }
    )


@admin_bp.post("/create-table", name="admin.create_table")
@admin_required
async def create_table(request: Request):
    form = await request.form()
    table_name = form.get("table_name", "").strip()
    column_definitions = form.get("columns", "").strip()
    table_options = form.get("table_options", "").strip()

    if not table_name or not column_definitions:
        flash(request, "Table name and column definition are required.", "error")
        return RedirectResponse(frontend_admin_dashboard_url(request), status_code=302)

    if _has_multiple_statements(column_definitions):
        flash(request, "カラム定義に複数の文を含めることはできません。", "error")
        return RedirectResponse(frontend_admin_dashboard_url(request), status_code=302)

    if table_options:
        normalized_options = _normalize_fragment(table_options)
        if _has_multiple_statements(normalized_options):
            flash(request, "テーブルオプションに複数の文を含めることはできません。", "error")
            return RedirectResponse(frontend_admin_dashboard_url(request), status_code=302)
        table_options = normalized_options

    try:
        await run_blocking(
            _create_table_in_db, table_name, column_definitions, table_options
        )
        flash(request, f"Table '{table_name}' created successfully.", "success")
    except Error:
        logger.exception("Failed to create table.")
        flash(request, "Failed to create table due to an internal error.", "error")

    return RedirectResponse(frontend_admin_dashboard_url(request), status_code=302)


@admin_bp.post("/api/create-table", name="admin.api_create_table")
async def api_create_table(request: Request):
    guard = _admin_guard(request)
    if guard is not None:
        return guard

    payload = await _get_payload(request)
    table_name = (payload.get("table_name") or "").strip()
    column_definitions = (payload.get("columns") or "").strip()
    table_options = (payload.get("table_options") or "").strip()

    if not table_name or not column_definitions:
        flash(request, "Table name and column definition are required.", "error")
        return jsonify(
            {"status": "fail", "error": "Table name and column definition are required."},
            status_code=400,
        )

    if _has_multiple_statements(column_definitions):
        flash(request, "カラム定義に複数の文を含めることはできません。", "error")
        return jsonify(
            {"status": "fail", "error": "Invalid column definition."}, status_code=400
        )

    if table_options:
        normalized_options = _normalize_fragment(table_options)
        if _has_multiple_statements(normalized_options):
            flash(request, "テーブルオプションに複数の文を含めることはできません。", "error")
            return jsonify(
                {"status": "fail", "error": "Invalid table options."}, status_code=400
            )
        table_options = normalized_options

    try:
        await run_blocking(
            _create_table_in_db, table_name, column_definitions, table_options
        )
        flash(request, f"Table '{table_name}' created successfully.", "success")
        return jsonify({"status": "success", "redirect": frontend_admin_dashboard_url(request)})
    except Error:
        flash(request, "Failed to create table due to an internal error.", "error")
        return log_and_internal_server_error(
            logger,
            "Admin API create-table failed.",
            status="fail",
        )


@admin_bp.post("/delete-table", name="admin.delete_table")
@admin_required
async def delete_table(request: Request):
    form = await request.form()
    table_name = form.get("table_name", "").strip()

    if not table_name:
        flash(request, "Table name is required for deletion.", "error")
        return RedirectResponse(frontend_admin_dashboard_url(request), status_code=302)

    try:
        deleted = await run_blocking(_drop_table_if_exists, table_name)
        if not deleted:
            flash(request, f"Table '{table_name}' does not exist.", "error")
            return RedirectResponse(frontend_admin_dashboard_url(request), status_code=302)
        flash(request, f"Table '{table_name}' deleted successfully.", "success")
    except Error:
        logger.exception("Failed to delete table.")
        flash(request, "Failed to delete table due to an internal error.", "error")

    return RedirectResponse(frontend_admin_dashboard_url(request), status_code=302)


@admin_bp.post("/api/delete-table", name="admin.api_delete_table")
async def api_delete_table(request: Request):
    guard = _admin_guard(request)
    if guard is not None:
        return guard

    payload = await _get_payload(request)
    table_name = (payload.get("table_name") or "").strip()

    if not table_name:
        flash(request, "Table name is required for deletion.", "error")
        return jsonify(
            {"status": "fail", "error": "Table name is required."}, status_code=400
        )

    try:
        deleted = await run_blocking(_drop_table_if_exists, table_name)
        if not deleted:
            flash(request, f"Table '{table_name}' does not exist.", "error")
            return jsonify(
                {"status": "fail", "error": "Table does not exist."}, status_code=404
            )
        flash(request, f"Table '{table_name}' deleted successfully.", "success")
        return jsonify({"status": "success", "redirect": frontend_admin_dashboard_url(request)})
    except Error:
        flash(request, "Failed to delete table due to an internal error.", "error")
        return log_and_internal_server_error(
            logger,
            "Admin API delete-table failed.",
            status="fail",
        )


@admin_bp.post("/add-column", name="admin.add_column")
@admin_required
async def add_column(request: Request):
    form = await request.form()
    table_name = form.get("table_name", "").strip()
    column_name = form.get("column_name", "").strip()
    column_type = form.get("column_type", "").strip()

    if not table_name or not column_name or not column_type:
        flash(request, "テーブル名、カラム名、カラム定義は必須です。", "error")
        return RedirectResponse(
            frontend_admin_dashboard_url(request, table=table_name), status_code=302
        )

    if _has_multiple_statements(column_type):
        flash(request, "カラム定義に複数の文を含めることはできません。", "error")
        return RedirectResponse(
            frontend_admin_dashboard_url(request, table=table_name), status_code=302
        )

    try:
        status = await run_blocking(_add_column_if_valid, table_name, column_name, column_type)
        if status == "missing_table":
            flash(request, f"テーブル '{table_name}' は存在しません。", "error")
            return RedirectResponse(frontend_admin_dashboard_url(request), status_code=302)
        if status == "duplicate_column":
            flash(request, f"カラム '{column_name}' は既に存在します。", "error")
            return RedirectResponse(
                frontend_admin_dashboard_url(request, table=table_name), status_code=302
            )
        flash(request, f"カラム '{column_name}' をテーブル '{table_name}' に追加しました。", "success")
    except Error:
        logger.exception("Failed to add column.")
        flash(request, "カラムの追加に失敗しました。内部エラーが発生しました。", "error")

    return RedirectResponse(
        frontend_admin_dashboard_url(request, table=table_name), status_code=302
    )


@admin_bp.post("/api/add-column", name="admin.api_add_column")
async def api_add_column(request: Request):
    guard = _admin_guard(request)
    if guard is not None:
        return guard

    payload = await _get_payload(request)
    table_name = (payload.get("table_name") or "").strip()
    column_name = (payload.get("column_name") or "").strip()
    column_type = (payload.get("column_type") or "").strip()

    if not table_name or not column_name or not column_type:
        flash(request, "テーブル名、カラム名、カラム定義は必須です。", "error")
        return jsonify(
            {"status": "fail", "error": "Required fields are missing."}, status_code=400
        )

    if _has_multiple_statements(column_type):
        flash(request, "カラム定義に複数の文を含めることはできません。", "error")
        return jsonify(
            {"status": "fail", "error": "Invalid column definition."}, status_code=400
        )

    try:
        status = await run_blocking(_add_column_if_valid, table_name, column_name, column_type)
        if status == "missing_table":
            flash(request, f"テーブル '{table_name}' は存在しません。", "error")
            return jsonify(
                {"status": "fail", "error": "Table does not exist."}, status_code=404
            )
        if status == "duplicate_column":
            flash(request, f"カラム '{column_name}' は既に存在します。", "error")
            return jsonify(
                {"status": "fail", "error": "Column already exists."}, status_code=400
            )
        flash(request, f"カラム '{column_name}' をテーブル '{table_name}' に追加しました。", "success")
        return jsonify(
            {
                "status": "success",
                "redirect": frontend_admin_dashboard_url(request, table=table_name),
            }
        )
    except Error:
        flash(request, "カラムの追加に失敗しました。内部エラーが発生しました。", "error")
        return log_and_internal_server_error(
            logger,
            "Admin API add-column failed.",
            status="fail",
        )


@admin_bp.post("/delete-column", name="admin.delete_column")
@admin_required
async def delete_column(request: Request):
    form = await request.form()
    table_name = form.get("table_name", "").strip()
    column_name = form.get("column_name", "").strip()

    if not table_name or not column_name:
        flash(request, "テーブル名とカラム名は必須です。", "error")
        return RedirectResponse(
            frontend_admin_dashboard_url(request, table=table_name), status_code=302
        )

    try:
        status, target_column = await run_blocking(
            _drop_column_if_valid, table_name, column_name
        )
        if status == "missing_table":
            flash(request, f"テーブル '{table_name}' は存在しません。", "error")
            return RedirectResponse(frontend_admin_dashboard_url(request), status_code=302)
        if status == "missing_column":
            flash(request, f"カラム '{column_name}' は存在しません。", "error")
            return RedirectResponse(
                frontend_admin_dashboard_url(request, table=table_name), status_code=302
            )
        if status == "last_column":
            flash(request, "テーブルには少なくとも1つのカラムが必要です。", "error")
            return RedirectResponse(
                frontend_admin_dashboard_url(request, table=table_name), status_code=302
            )
        if status != "ok" or target_column is None:
            flash(request, "カラムの削除に失敗しました。", "error")
            return RedirectResponse(
                frontend_admin_dashboard_url(request, table=table_name), status_code=302
            )
        flash(request, f"カラム '{target_column}' をテーブル '{table_name}' から削除しました。", "success")
    except Error:
        logger.exception("Failed to delete column.")
        flash(request, "カラムの削除に失敗しました。内部エラーが発生しました。", "error")

    return RedirectResponse(
        frontend_admin_dashboard_url(request, table=table_name), status_code=302
    )


@admin_bp.post("/api/delete-column", name="admin.api_delete_column")
async def api_delete_column(request: Request):
    guard = _admin_guard(request)
    if guard is not None:
        return guard

    payload = await _get_payload(request)
    table_name = (payload.get("table_name") or "").strip()
    column_name = (payload.get("column_name") or "").strip()

    if not table_name or not column_name:
        flash(request, "テーブル名とカラム名は必須です。", "error")
        return jsonify(
            {"status": "fail", "error": "Required fields are missing."}, status_code=400
        )

    try:
        status, target_column = await run_blocking(
            _drop_column_if_valid, table_name, column_name
        )
        if status == "missing_table":
            flash(request, f"テーブル '{table_name}' は存在しません。", "error")
            return jsonify(
                {"status": "fail", "error": "Table does not exist."}, status_code=404
            )
        if status == "missing_column":
            flash(request, f"カラム '{column_name}' は存在しません。", "error")
            return jsonify(
                {"status": "fail", "error": "Column does not exist."}, status_code=404
            )
        if status == "last_column":
            flash(request, "テーブルには少なくとも1つのカラムが必要です。", "error")
            return jsonify(
                {"status": "fail", "error": "Cannot delete the last column."}, status_code=400
            )
        if status != "ok" or target_column is None:
            flash(request, "カラムの削除に失敗しました。", "error")
            return jsonify({"status": "fail", "error": "Column deletion failed."}, status_code=500)
        flash(
            request,
            f"カラム '{target_column}' をテーブル '{table_name}' から削除しました。",
            "success",
        )
        return jsonify(
            {
                "status": "success",
                "redirect": frontend_admin_dashboard_url(request, table=table_name),
            }
        )
    except Error:
        flash(request, "カラムの削除に失敗しました。内部エラーが発生しました。", "error")
        return log_and_internal_server_error(
            logger,
            "Admin API delete-column failed.",
            status="fail",
        )
