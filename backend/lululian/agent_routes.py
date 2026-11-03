"""Fixed HTTP capabilities for model setup and human-directed prompt optimization."""

from fastapi import APIRouter

from .feedback import ApplyFeedback, FeedbackInput
from .model_agent import SetupInput


def agent_router(app, store):
    router = APIRouter(prefix="/api", tags=["model-control"])

    @router.get("/model-agent/runs")
    def setup_runs():
        return app.state.model_agent.runs()

    @router.post("/model-agent/runs", status_code=202)
    def start_setup(body: SetupInput):
        return app.state.model_agent.start(body)

    @router.post("/model-agent/runs/{rid}/cancel")
    def cancel_setup(rid: str):
        return app.state.model_agent.cancel(rid)

    @router.get("/projects/{pid}/feedback")
    def feedback_list(pid: str):
        return app.state.runner.feedback.list(pid)

    @router.post("/projects/{pid}/feedback", status_code=201)
    def create_feedback(pid: str, body: FeedbackInput):
        return app.state.runner.feedback.create(pid, body)

    @router.post("/projects/{pid}/feedback/{fid}/apply")
    def apply_feedback(pid: str, fid: str, body: ApplyFeedback):
        return app.state.runner.feedback.apply(pid, fid, body)

    return router
