# Executive Data Visualization Workshop — Instructor Guide

## Your Dataset Schema (`cleaned_dataset.parquet`)

| Column | Type | Role |
|---|---|---|
| `customer_id` | VARCHAR | Primary key (C001–C025) |
| `full_name` | VARCHAR | Customer display name |
| `email` | VARCHAR | Contact (nullable) |
| `region` | VARCHAR | 10 Philippine regions (NCR, Region I–XIII) |
| `segment` | VARCHAR | ENTERPRISE / SME |
| `revenue` | DECIMAL(15,2) | Total revenue (₱) — **primary metric** |
| `order_count` | INTEGER | Transaction volume |
| `signup_date` | DATE | Customer onboarding date |
| `status` | VARCHAR | active / inactive |

**Key stats:** 25 customers · ₱3.41M total revenue · 1,120 orders · 10 regions · 2 segments

---

## Part 1: Strategic Foundations

### 1. Cognitive Load Reduction
Executives make 35+ decisions per day under time pressure. A well-designed chart delivers the "so what" in under 5 seconds — dense tables require 30–60 seconds of parsing. Your dashboard should answer "what changed, what matters, what do I do?" without requiring the viewer to read a single label twice.

### 2. Actionable Insights vs. Vanity Metrics
Showing "₱3.4M total revenue" is a vanity metric. Showing "NCR contributes 39% of total revenue but only 32% of customers — our regional diversification strategy is lagging" is actionable. Every chart must answer: who should do what differently based on this information?

### 3. Single Source of Truth
When Finance, Sales, and Operations each pull from different spreadsheets, conflicting numbers erode trust. A centralized Vercel-deployed dashboard fed by a validated Parquet file means every meeting references identical numbers — eliminating "whose spreadsheet is right?" debates.
