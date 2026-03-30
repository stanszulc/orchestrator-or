from mcp.server.fastmcp import FastMCP
import math
import json
import os
from starlette.applications import Starlette
from starlette.routing import Mount, Route
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
from mcp.server.sse import SseServerTransport
import uvicorn

mcp = FastMCP("OR Flow Optimizer")

# ── Ścieżka do pliku FHIR ────────────────────────────────────────────────────
FHIR_FILE = os.path.join(
    os.path.dirname(__file__),
    "../../fhir-data/fhir_patients_10.json"
)

# ── MCP Tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def get_patients_from_fhir() -> dict:
    """
    Read surgical patients from FHIR R4 Bundle (Observation resources).
    Extracts procedure, duration_p50 and risk from note field.
    No parameters needed - reads the OR schedule file automatically.
    """
    try:
        with open(FHIR_FILE, "r", encoding="utf-8") as f:
            bundle = json.load(f)

        patients = []
        for entry in bundle.get("entry", []):
            resource = entry.get("resource", {})
            if resource.get("resourceType") != "Observation":
                continue

            # Parsuj note field: "patient_id=P001|name=...|procedure=...|duration_p50=58|risk=Standard"
            notes = resource.get("note", [])
            if not notes:
                continue

            note_text = notes[0].get("text", "")
            fields = {}
            for part in note_text.split("|"):
                if "=" in part:
                    k, v = part.split("=", 1)
                    fields[k.strip()] = v.strip()

            if "procedure" not in fields or "duration_p50" not in fields:
                continue

            # patient_id z note lub z subject reference
            patient_id = fields.get("patient_id") or \
                resource.get("subject", {}).get("reference", "").split("/")[-1]

            patients.append({
                "patient_id": patient_id,
                "name":        fields.get("name", patient_id),
                "procedure":   fields["procedure"],
                "duration_p50": float(fields["duration_p50"]),
                "risk":        fields.get("risk", "Standard"),
                "cpt":         fields.get("cpt", ""),
                "snomed":      fields.get("snomed", ""),
            })

        return {
            "patients": patients,
            "count": len(patients),
            "source": "FHIR R4 Bundle · Observation resources",
        }

    except FileNotFoundError:
        return {"error": f"FHIR file not found: {FHIR_FILE}", "patients": []}
    except Exception as e:
        return {"error": str(e), "patients": []}


@mcp.tool()
def calculate_robust_buffer(
    patient_id: str,
    procedure: str,
    duration_p50: float,
    risk: str,
    gamma: float = 0.5
) -> dict:
    """Calculate MIT Robust Optimization time buffer for a surgical procedure."""
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
    """Generate full Robust-optimized OR schedule for a list of patients."""
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
            p.get("duration_p50", 60),
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
            "name":  p.get("name", p.get("patient_id", "?")),
            "order": len(schedule) + 1,
            "start": f"{sh:02d}:{sm:02d}",
            "end":   f"{eh:02d}:{em:02d}",
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


@mcp.tool()
def plan_or_from_fhir(
    gamma: float = 0.5,
    or_capacity_minutes: int = 480,
    start_time: str = "07:30"
) -> dict:
    """
    Full pipeline: read patients from FHIR → optimize OR schedule.
    Agent can call this single tool without any patient data.
    Just say 'plan the OR for tomorrow' and this tool does everything.
    """
    fhir_result = get_patients_from_fhir()

    if "error" in fhir_result:
        return {"error": fhir_result["error"]}

    patients = fhir_result["patients"]
    if not patients:
        return {"error": "No patients found in FHIR bundle"}

    schedule_result = optimize_schedule(patients, gamma, or_capacity_minutes, start_time)

    return {
        **schedule_result,
        "fhir_source": fhir_result["source"],
        "patients_read": fhir_result["count"],
    }


# ── REST endpoint /optimize ───────────────────────────────────────────────────

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


async def handle_plan_from_fhir(request: Request):
    """GET /plan — pełny pipeline FHIR → harmonogram"""
    try:
        gamma = float(request.query_params.get("gamma", 0.5))
        result = plan_or_from_fhir(gamma=gamma)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


async def handle_health(request: Request):
    """GET /health"""
    return JSONResponse({"status": "ok", "server": "OR Flow Optimizer",
                         "tools": ["get_patients_from_fhir", "optimize_schedule",
                                   "plan_or_from_fhir", "calculate_robust_buffer"]})


# ── SSE transport ─────────────────────────────────────────────────────────────

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
        Route("/optimize",  endpoint=handle_optimize,        methods=["POST"]),
        Route("/plan",      endpoint=handle_plan_from_fhir,  methods=["GET"]),
        Route("/health",    endpoint=handle_health,          methods=["GET"]),
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
