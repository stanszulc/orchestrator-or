from mcp.server.fastmcp import FastMCP
import math

mcp = FastMCP("OR Flow Optimizer")

@mcp.tool()
def calculate_robust_buffer(patient_id: str, procedure: str, duration_p50: float, risk: str, gamma: float = 0.5) -> dict:
    """Calculate MIT Robust Optimization time buffer for a surgical procedure."""
    sigma_map = {"Low": 0.10, "Standard": 0.15, "High": 0.25, "Critical": 0.40}
    if risk == "Critical":
        return {"patient_id": patient_id, "status": "EXCLUDED", "reason": "Critical risk requires dedicated OR"}
    sigma = sigma_map.get(risk, 0.15)
    buffer = round(gamma * sigma * math.sqrt(duration_p50), 1)
    scheduled = round(duration_p50 + buffer, 1)
    overrun = {"Low": "4%", "Standard": "8%", "High": "15%"}.get(risk, "unknown")
    return {"patient_id": patient_id, "procedure": procedure, "risk": risk, "duration_p50": duration_p50, "buffer_minutes": buffer, "scheduled_minutes": scheduled, "overrun_probability": overrun}

@mcp.tool()
def optimize_schedule(patients: list, gamma: float = 0.5, or_capacity_minutes: int = 480, start_time: str = "07:30") -> dict:
    """Generate full Robust-optimized OR schedule for a list of patients."""
    order = {"Standard": 0, "High": 1, "Low": 2, "Critical": 99}
    sorted_patients = sorted(patients, key=lambda p: order.get(p.get("risk", "Standard"), 99))
    schedule = []
    rejected = []
    total_minutes = 0
    h, m = map(int, start_time.split(":"))
    current_minutes = h * 60 + m
    for p in sorted_patients:
        r = calculate_robust_buffer(p.get("patient_id","?"), p.get("procedure","?"), p.get("duration_p50", 60), p.get("risk","Standard"), gamma)
        if r.get("status") == "EXCLUDED":
            rejected.append(r)
            continue
        if total_minutes + r["scheduled_minutes"] > or_capacity_minutes:
            rejected.append({**r, "status": "EXCLUDED", "reason": "OR capacity exceeded"})
            continue
        sh, sm = current_minutes // 60, current_minutes % 60
        end = current_minutes + r["scheduled_minutes"]
        eh, em = int(end) // 60, int(end) % 60
        schedule.append({**r, "order": len(schedule)+1, "start": f"{sh:02d}:{sm:02d}", "end": f"{eh:02d}:{em:02d}"})
        total_minutes += r["scheduled_minutes"]
        current_minutes = end
    util = round((total_minutes / or_capacity_minutes) * 100, 1)
    return {"schedule": schedule, "rejected": rejected, "summary": {"total_minutes": total_minutes, "utilization_percent": util, "overrun_risk": "Low" if util < 85 else "Medium" if util < 95 else "High", "gamma": gamma}}

if __name__ == "__main__":
    import uvicorn
    from mcp.server.sse import SseServerTransport
    from starlette.applications import Starlette
    from starlette.routing import Mount, Route

    sse = SseServerTransport("/messages/")

    async def handle_sse(request):
        async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
            await mcp._mcp_server.run(streams[0], streams[1], mcp._mcp_server.create_initialization_options())

    app = Starlette(routes=[
        Route("/sse", endpoint=handle_sse),
        Mount("/messages/", app=sse.handle_post_message),
    ])

    uvicorn.run(app, host="0.0.0.0", port=8001)
