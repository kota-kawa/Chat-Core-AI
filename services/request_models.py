from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

NonEmptyStr = Annotated[str, Field(min_length=1)]


class RequestPayloadModel(BaseModel):
    # 余分なキーを無視しつつ文字列の前後空白を自動で除去する共通ベース
    # Common base model that strips string whitespace and ignores extra fields.
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class EmailRequest(RequestPayloadModel):
    # メールアドレス入力用ペイロード
    # Payload for email address input.
    email: NonEmptyStr


class AuthCodeRequest(RequestPayloadModel):
    # 認証コード送信用ペイロード
    # Payload for verification/login code input.
    authCode: str | None = None


class NewChatRoomRequest(RequestPayloadModel):
    # チャットルーム新規作成APIの入力
    # Input payload for chat room creation.
    id: str
    title: str = "新規チャット"


class ChatRoomIdRequest(RequestPayloadModel):
    room_id: NonEmptyStr


class RenameChatRoomRequest(RequestPayloadModel):
    room_id: NonEmptyStr
    new_title: NonEmptyStr


class ShareChatRoomRequest(RequestPayloadModel):
    room_id: NonEmptyStr


class ChatMessageRequest(RequestPayloadModel):
    message: str
    chat_room_id: str = "default"
    model: str | None = None


class UpdateTasksOrderRequest(RequestPayloadModel):
    order: list[NonEmptyStr] = Field(min_length=1)


class DeleteTaskRequest(RequestPayloadModel):
    task: NonEmptyStr


class EditTaskRequest(RequestPayloadModel):
    old_task: NonEmptyStr
    new_task: NonEmptyStr
    prompt_template: str | None = None
    response_rules: str | None = None
    output_skeleton: str | None = None
    input_examples: str | None = None
    output_examples: str | None = None


class AddTaskRequest(RequestPayloadModel):
    title: NonEmptyStr
    prompt_content: NonEmptyStr
    response_rules: str = ""
    output_skeleton: str = ""
    input_examples: str = ""
    output_examples: str = ""


class SharedPromptCreateRequest(RequestPayloadModel):
    title: NonEmptyStr
    category: NonEmptyStr
    content: NonEmptyStr
    author: NonEmptyStr
    input_examples: str = ""
    output_examples: str = ""


class BookmarkCreateRequest(RequestPayloadModel):
    title: NonEmptyStr
    content: NonEmptyStr
    input_examples: str = ""
    output_examples: str = ""


class BookmarkDeleteRequest(RequestPayloadModel):
    title: NonEmptyStr


class PromptListEntryCreateRequest(RequestPayloadModel):
    prompt_id: int | None = None
    title: NonEmptyStr
    category: str = ""
    content: NonEmptyStr
    input_examples: str = ""
    output_examples: str = ""


class PromptUpdateRequest(RequestPayloadModel):
    title: NonEmptyStr
    category: NonEmptyStr
    content: NonEmptyStr
    input_examples: str = ""
    output_examples: str = ""


class MemoCreateRequest(RequestPayloadModel):
    # メモ保存APIの入力
    # Input payload for memo creation API.
    input_content: str = ""
    ai_response: NonEmptyStr
    title: str = ""
    tags: str = ""
