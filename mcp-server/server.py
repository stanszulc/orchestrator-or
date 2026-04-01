from mcp.server.fastmcp import FastMCP
import math
from starlette.applications import Starlette
from starlette.routing import Mount, Route
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
from mcp.server.sse import SseServerTransport
import uvicorn

mcp = FastMCP("OR Flow Optimizer")

# ── MCP Tools ────────────────────────────────────────────────────────────────
# Privacy by design: serwer nie przechowuje danych pacjentów.
# Agent wysyła tylko patient_id + dane medyczne potrzebne do obliczeń.
# Dane osobowe (nazwiska, PESEL) zostają w Prompt Opinion.

@mcp.tool()
def calculate_robust_buffer(
    patient_id: str,
    procedure: str,
    duration_p50: float,
    risk: str,
    gamma: float = 0.5
) -> dict:
    """
    Calculate MIT Robust Optimization time buffer for a surgical procedure.
    Uses Box Uncertainty Set (Denton et al.) with Gamma parameter.
    Risk levels: Low (σ=0.10), Standard (σ=0.15), High (σ=0.25), Critical (excluded).
    """
    sigma_map = {"Low": 0.10, "Standard": 0.15, "High": 0.25, "Critical": 0.40}

    if risk == "Critical":
        return {
            "patient_id": patient_id,
            "status": "EXCLUDED",
            "reason": "Critical risk requires dedicated OR"
        }

    sigma = sigma_map.get(risk, 0.15)
    buffer = round(gamma * sigma * math.sqrt(duration_p50), 1)
    scheduled = round(duration_p50 + buffer, 1)
    overrun = {"Low": "4%", "Standard": "8%", "High": "15%"}.get(risk, "unknown")

    return {
        "patient_id": patient_id,
        "procedure": procedure,
        "risk": risk,
        "duration_p50": duration_p50,
        "buffer_minutes": buffer,
        "scheduled_minutes": scheduled,
        "overrun_probability": overrun,
    }


@mcp.tool()
def optimize_schedule(
    patients: list,
    gamma: float = 0.5,
    or_capacity_minutes: int = 480,
    start_time: str = "07:30"
) -> dict:
    """
    Generate full Robust-optimized OR schedule for a list of patients.
    Agent provides patient list from Prompt Opinion platform.
    No patient data is stored on this server - privacy by design.

    patients format: [{"patient_id": "P001", "procedure": "Appendectomy",
                       "duration_p50": 58, "risk": "Standard"}, ...]
    """
    order = {"Standard": 0, "High": 1, "Low": 2, "Critical": 99}
    sorted_patients = sorted(
        patients,
        key=lambda p: order.get(p.get("risk", "Standard"), 99)
    )

    schedule = []
    rejected = []
    total_minutes = 0

    h, m = map(int, start_time.split(":"))
    current_minutes = h * 60 + m

    for p in sorted_patients:
        r = calculate_robust_buffer(
            p.get("patient_id", "?"),
            p.get("procedure", "?"),
            float(p.get("duration_p50", 60)),
            p.get("risk", "Standard"),
            gamma
        )

        if r.get("status") == "EXCLUDED":
            rejected.append(r)
            continue

        if total_minutes + r["scheduled_minutes"] > or_capacity_minutes:
            rejected.append({**r, "status": "EXCLUDED", "reason": "OR capacity exceeded"})
            continue

        sh = current_minutes // 60
        sm = current_minutes % 60
        end = current_minutes + r["scheduled_minutes"]
        eh = int(end) // 60
        em = int(end) % 60

        schedule.append({
            **r,
            "order": len(schedule) + 1,
            "start": f"{int(sh):02d}:{int(sm):02d}",
            "end":   f"{int(eh):02d}:{int(em):02d}",
        })

        total_minutes += r["scheduled_minutes"]
        current_minutes = end

    util = round((total_minutes / or_capacity_minutes) * 100, 1)

    return {
        "schedule": schedule,
        "rejected": rejected,
        "summary": {
            "total_minutes": total_minutes,
            "utilization_percent": util,
            "overrun_risk": (
                "Low" if util < 85
                else "Medium" if util < 95
                else "High"
            ),
            "gamma": gamma,
            "scheduled_count": len(schedule),
            "rejected_count": len(rejected),
        }
    }


# ── REST endpoint /optimize (dla React Dashboard) ────────────────────────────

async def handle_optimize(request: Request):
    """POST /optimize — dla React Dashboard"""
    try:
        body = await request.json()
        patients = body.get("patients", [])
        gamma = float(body.get("gamma", 0.5))
        capacity = int(body.get("or_capacity_minutes", 480))
        start_time = body.get("start_time", "07:30")

        if not patients:
            return JSONResponse({"error": "No patients provided"}, status_code=400)

        result = optimize_schedule(patients, gamma, capacity, start_time)
        return JSONResponse(result)

    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


async def handle_health(request: Request):
    """GET /health"""
    return JSONResponse({
        "status": "ok",
        "server": "OR Flow Optimizer",
        "privacy": "No patient data stored. Agent sends data, server computes only.",
        "tools": ["calculate_robust_buffer", "optimize_schedule"],
    })


# ── SSE transport (dla MCP / Prompt Opinion) ─────────────────────────────────

sse = SseServerTransport("/messages/")

async def handle_sse(request: Request):
    async with sse.connect_sse(
        request.scope, request.receive, request._send
    ) as streams:
        await mcp._mcp_server.run(
            streams[0], streams[1],
            mcp._mcp_server.create_initialization_options()
        )


# ── Starlette app ─────────────────────────────────────────────────────────────

app = Starlette(
    routes=[
        Route("/sse",       endpoint=handle_sse),
        Route("/optimize",  endpoint=handle_optimize, methods=["POST"]),
        Route("/health",    endpoint=handle_health,   methods=["GET"]),
        Mount("/messages/", app=sse.handle_post_message),
    ]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
