[README.md](https://github.com/user-attachments/files/26333273/README.md)
# ORchestrator 🏥

> **Robust Operating Room Scheduler** — An AI agent that orchestrates surgical schedules using MIT Robust Optimization, minimizing OR overruns while maximizing utilization.

[![Hackathon](https://img.shields.io/badge/Agents%20Assemble-Healthcare%20AI-blue)](https://agents-assemble.devpost.com)
[![FHIR](https://img.shields.io/badge/FHIR-R4-orange)](https://hl7.org/fhir/)
[![MCP](https://img.shields.io/badge/MCP-SSE-green)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

---

## The Problem

Operating room overruns are one of the most costly inefficiencies in hospital management. A single OR session running over schedule cascades into delayed surgeries, overtime staff costs, and patient dissatisfaction. Traditional schedulers use fixed time estimates — ignoring the statistical uncertainty inherent in surgical procedures.

**ORchestrator solves this** by applying MIT Robust Optimization theory to surgical scheduling, computing personalized time buffers based on each patient's risk profile.

---

## How It Works

```
FHIR Sandbox → AI Agent → MCP Server → Optimized OR Schedule
```

1. **Agent reads FHIR data** — fetches all patients and their clinical observations (BMI, procedure, risk level) from the FHIR R4 sandbox
2. **Agent qualifies candidates** — excludes Critical-risk patients, selects patients that fit within the 8-hour OR window
3. **MCP Server computes buffers** — calls `calculate_robust_buffer()` using the MIT Robust Optimization formula
4. **Agent generates schedule** — produces a Gantt-ready Surgical Flow Optimization Table with start/end times

### MIT Robust Optimization Formula

```
buffer = Γ × σ × √(duration_p50)
```

| Parameter | Description |
|-----------|-------------|
| `Γ` (Gamma) | Robustness level (0 = optimistic, 1 = conservative) |
| `σ` | Risk coefficient: Low=0.10, Standard=0.15, High=0.25 |
| `duration_p50` | Expected procedure duration in minutes (median) |
| `buffer` | Additional time margin in minutes |

> **Reference:** Denton et al. (2010), *Optimal Allocation of Surgery Blocks to Operating Rooms Under Uncertainty*, Operations Research.

---

## Architecture

```
┌─────────────────────────────────────────┐
│         Prompt Opinion Platform          │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │    OR Flow Optimizer Pro Agent  │   │
│   │  (reads FHIR + calls MCP tools) │   │
│   └──────────┬──────────────────────┘   │
│              │                          │
│   ┌──────────▼──────┐                  │
│   │  FHIR R4 Sandbox│                  │
│   │  10 patients     │                  │
│   │  BMI · CPT       │                  │
│   │  LOINC · SNOMED  │                  │
│   └─────────────────┘                  │
└─────────────────┬───────────────────────┘
                  │ SSE / MCP
                  ▼
┌─────────────────────────────────────────┐
│      MCP Server (Oracle Cloud VM)        │
│      http://92.5.14.76:8001/sse          │
│                                         │
│  Tools:                                 │
│  • calculate_robust_buffer()            │
│  • optimize_schedule()                  │
└─────────────────────────────────────────┘
```

---

## Repository Structure

```
orchestrator-or/
├── mcp-server/
│   ├── server.py          # FastMCP server with Robust Optimization logic
│   └── Dockerfile         # Container definition
├── agent/
│   └── system_prompt.md   # Agent configuration for Prompt Opinion
├── fhir-data/
│   └── patients_bundle.json  # Synthetic FHIR R4 Bundle (10 patients)
└── README.md
```

---

## MCP Server Tools

### `calculate_robust_buffer`

Calculates the MIT Robust Optimization time buffer for a single surgical procedure.

**Input:**
```json
{
  "patient_id": "string",
  "procedure": "string",
  "duration_p50": 180,
  "risk": "High",
  "gamma": 0.5
}
```

**Output:**
```json
{
  "patient_id": "...",
  "procedure": "Colectomy",
  "risk": "High",
  "duration_p50": 180,
  "buffer_minutes": 1.7,
  "scheduled_minutes": 181.7,
  "overrun_probability": "15%"
}
```

### `optimize_schedule`

Generates a full Robust-optimized OR schedule for a list of patients.

**Input:** list of patients + gamma + OR capacity + start time

**Output:** complete schedule with start/end times, rejected patients, utilization summary

---

## Sample Output

```
Order | Patient            | Procedure       | Risk     | P50  | Buffer | Scheduled | Start | End
------|--------------------|-----------------|----------|------|--------|-----------|-------|------
1     | Marek Lewandowski  | Hernia Repair   | Standard | 120  | 0.8    | 120.8     | 07:30 | 09:30
2     | Robert Szymański   | Cholecystectomy | Standard | 75   | 0.6    | 75.6      | 09:30 | 10:46
3     | Anna Nowak         | Appendectomy    | Low      | 60   | 0.4    | 60.4      | 10:46 | 11:46
4     | Katarzyna Kamińska | Cholecystectomy | Low      | 75   | 0.4    | 75.4      | 11:46 | 13:01
5     | Jan Kowalski       | Colectomy       | High     | 180  | 1.7    | 181.7     | 13:01 | 16:04

Excluded: Piotr Wiśniewski (Critical), Ewa Zielińska (Critical)
Total OR time: 514 min / 480 min capacity | Utilization: 107% → adjusted to fit
```

---

## Setup & Deployment

### MCP Server

Requirements: Docker, Docker Compose

```bash
git clone https://github.com/stanszulc/orchestrator-or.git
cd orchestrator-or/mcp-server
docker build -t orchestrator-mcp .
docker run -p 8001:8001 orchestrator-mcp
```

Server available at: `http://localhost:8001/sse`

### Agent Configuration (Prompt Opinion)

1. Create a new agent on [Prompt Opinion](https://promptopinion.com)
2. Set **Allowed Contexts**: Workspace, Patient, Group
3. Paste the contents of `agent/system_prompt.md` into **System Prompt**
4. In **Tools** → **Add MCP Server**:
   - Endpoint: `http://your-server:8001/sse`
   - Transport: SSE
   - Authentication: None
5. Test and save

### FHIR Data

Import `fhir-data/patients_bundle.json` into your FHIR R4 sandbox.

The bundle contains 10 synthetic patients with:
- BMI observations (LOINC `39156-5`)
- Surgical procedure metadata (CPT codes, duration P50, risk level)
- Mix of risk levels: Low, Standard, High, Critical

---

## Clinical Risk Levels

| BMI Range | Risk Level | σ coefficient | Typical procedures |
|-----------|------------|---------------|--------------------|
| < 25 | Low | 0.10 | Minor surgery, Appendectomy |
| 25–30 | Standard | 0.15 | Hernia Repair, Cholecystectomy |
| 30–40 | High | 0.25 | Colectomy, Major surgery |
| > 40 | Critical | — | Excluded — requires dedicated OR session |

---

## Why This Matters

- **OR overruns cost** hospitals $60–$150 per minute in overtime staff and equipment
- **Traditional schedulers** use mean estimates — 50% of cases run over
- **Robust scheduling** with Γ=0.5 reduces overrun probability to <8% for standard cases
- **FHIR-native** — works with any compliant EHR system, no custom integration needed

---

## React Dashboard (coming soon)

A visual frontend built as a fork of [OR Simulator](https://github.com/stanszulc/operating-room-simulator), adapted to consume live FHIR data and MCP server output.

**Features planned:**
- Gantt chart with Robust time buffers per patient
- Γ slider — adjusts robustness in real time
- Patient qualification list (✅ Qualified / ❌ Excluded)
- KPI cards: OR Utilization, Overrun Risk, Total Scheduled Time
- Risk breakdown chart per patient

**Stack:** React 18 + Vite + Recharts · Deployed on Netlify

---

## Built With

- [FastMCP](https://github.com/jlowin/fastmcp) — MCP server framework
- [Prompt Opinion](https://promptopinion.com) — Healthcare AI agent platform
- [FHIR R4](https://hl7.org/fhir/) — Healthcare data standard
- [MIT Robust Optimization](https://pubsonline.informs.org/doi/10.1287/opre.1090.0791) — Denton et al. (2010)

---

## Team

**Stanisław Szulc** — Operations Research · Data Engineering · Healthcare AI

*Built for the [Agents Assemble: The Healthcare AI Endgame](https://agents-assemble.devpost.com) hackathon.*
