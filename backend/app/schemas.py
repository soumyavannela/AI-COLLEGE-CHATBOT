from datetime import date

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    question: str = Field(min_length=2, max_length=1000)
    branch: str | None = Field(default=None, max_length=80)
    year: int | None = Field(default=None, ge=1, le=8)
    semester: int | None = Field(default=None, ge=1, le=16)
    section: str | None = Field(default=None, max_length=20)
    local_date: date | None = None


class Source(BaseModel):
    title: str
    page: int | None = None


class ChatResponse(BaseModel):
    answer: str
    sources: list[Source] = []
    grounded: bool


class AttendanceRequest(BaseModel):
    attended: int = Field(ge=0)
    total: int = Field(gt=0)
    target_percent: float = Field(gt=0, lt=100)


class AttendanceResponse(BaseModel):
    current_percent: float
    target_percent: float
    classes_to_attend: int
