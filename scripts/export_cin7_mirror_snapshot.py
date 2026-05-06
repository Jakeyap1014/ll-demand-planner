#!/usr/bin/env python3
"""Export the local Cin7 mirror into ll-demand-planner snapshot files.

The Render-hosted planner cannot read Caesar's local Postgres mirror directly, so
this script converts the protected mirror tables into the same JSON cache shape
that server.js already loads for the Demand Planner and PO tab.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / "data" / "cache-snapshot.json"
CACHE_BACKUP_PATH = ROOT / "data" / "cache-snapshot.last-good.json"
PO_PATH = ROOT / "data" / "po-snapshot.json"
PO_BACKUP_PATH = ROOT / "data" / "po-snapshot.last-good.json"
PO_ETA_HISTORY_PATH = ROOT / "data" / "po-eta-history.json"
PO_ETA_HISTORY_BACKUP_PATH = ROOT / "data" / "po-eta-history.last-good.json"
PG_CRED_PATH = Path("/home/lifely-agent/.openclaw/credentials/cin7-mirror-postgres.json")


def json_default(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return value


def to_float(value, default=0.0):
    if value is None:
        return default
    return float(value)


def iso(value):
    if not value:
        return None
    if isinstance(value, str):
        return value
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def load_existing_snapshot():
    try:
        return json.loads(CACHE_PATH.read_text())
    except Exception:
        return {}


def connect():
    pg = json.loads(PG_CRED_PATH.read_text())
    return psycopg2.connect(
        host=pg["host"],
        port=pg["port"],
        dbname=pg["database"],
        user=pg["user"],
        password=pg["password"],
    )


def fetch_one(cur, query, params=None):
    cur.execute(query, params or ())
    row = cur.fetchone()
    if not row:
        return None
    return list(row.values())[0]


def build_products_and_stock(cur):
    products: dict[str, dict] = {}
    stock_by_branch: dict[str, dict] = defaultdict(dict)

    cur.execute(
        """
        select
          po.sku,
          po.raw_payload as option_raw,
          p.code as product_code,
          p.raw_payload as product_raw,
          coalesce(sum(sl.stock_on_hand), 0) as total_soh,
          coalesce(sum(sl.available), 0) as total_available,
          max(greatest(
            coalesce(po.synced_at, 'epoch'::timestamptz),
            coalesce(p.synced_at, 'epoch'::timestamptz),
            coalesce(sl.snapshot_as_of, 'epoch'::timestamptz)
          )) as newest_seen
        from cin7_core.product_options po
        join cin7_core.products p on p.product_id = po.product_id
        left join cin7_core.stock_levels sl on sl.product_option_id = po.product_option_id
        where coalesce(po.sku, '') <> ''
        group by po.sku, po.raw_payload, p.code, p.raw_payload
        order by po.sku
        """
    )
    for row in cur.fetchall():
        sku = row["sku"]
        option_raw = row.get("option_raw") or {}
        product_raw = row.get("product_raw") or {}
        price_columns = option_raw.get("priceColumns") or {}
        cost_aud = to_float(price_columns.get("costAUD"))
        if not cost_aud and price_columns.get("costUSD"):
            # Keep the same default fallback as server.js. The live app refreshes fx separately.
            cost_aud = to_float(price_columns.get("costUSD")) * 1.45
        products[sku] = {
            "soh": to_float(row.get("total_soh")),
            "available": to_float(row.get("total_available")),
            "costAUD": cost_aud,
            "cbm": to_float(product_raw.get("volume")),
        }

    cur.execute(
        """
        select
          po.sku,
          sl.branch_id,
          coalesce(b.raw_payload->>'company', b.name, '') as branch_name,
          sl.stock_on_hand,
          sl.available
        from cin7_core.stock_levels sl
        join cin7_core.product_options po on po.product_option_id = sl.product_option_id
        left join cin7_core.branches b on b.branch_id = sl.branch_id
        where coalesce(po.sku, '') <> ''
        order by po.sku, sl.branch_id
        """
    )
    for row in cur.fetchall():
        sku = row["sku"]
        branch_id = str(int(row["branch_id"]))
        stock_by_branch[sku][branch_id] = {
            "soh": to_float(row.get("stock_on_hand")),
            "available": to_float(row.get("available")),
            "branchName": row.get("branch_name") or "",
        }
        if sku not in products:
            products[sku] = {"soh": 0, "available": 0, "costAUD": 0, "cbm": 0}

    return products, dict(stock_by_branch)


def clean_reference(ref):
    ref = ref or ""
    return ref[:-6] if ref.lower().endswith("-cover") else ref


def build_purchase_orders(cur):
    cur.execute(
        """
        select
          po.purchase_order_id,
          po.reference,
          po.status,
          po.stage,
          po.estimated_arrival_date,
          po.estimated_delivery_date,
          po.fully_received_date,
          po.total,
          po.currency_code,
          po.tracking_code,
          po.raw_payload,
          coalesce(jsonb_object_agg(pol.sku, pol.qty) filter (where pol.sku is not null and coalesce(pol.qty,0) > 0), '{}'::jsonb) as items
        from cin7_core.purchase_orders po
        left join cin7_core.purchase_order_lines pol on pol.purchase_order_id = po.purchase_order_id
        where not coalesce(po.is_void, false)
        group by po.purchase_order_id
        order by po.purchase_order_id
        """
    )
    rows = []
    for row in cur.fetchall():
        raw = row.get("raw_payload") or {}
        items = {sku: to_float(qty) for sku, qty in (row.get("items") or {}).items() if sku and to_float(qty) > 0}
        if not items:
            continue
        custom_fields = raw.get("customFields") or {}
        rows.append(
            {
                "id": row.get("purchase_order_id") or raw.get("id"),
                "reference": clean_reference(row.get("reference")),
                "status": row.get("status") or raw.get("status"),
                "stage": row.get("stage") or raw.get("stage") or "",
                "arrival": iso(row.get("estimated_arrival_date")),
                "etd": iso(row.get("estimated_delivery_date")),
                "estimatedArrivalDate": iso(row.get("estimated_arrival_date")),
                "fullyReceivedDate": iso(row.get("fully_received_date")),
                "customFields": custom_fields,
                "company": raw.get("company") or "",
                "total": to_float(row.get("total")),
                "currencyCode": row.get("currency_code") or raw.get("currencyCode") or "USD",
                "deliveryCountry": raw.get("deliveryCountry") or "",
                "deliveryCity": raw.get("deliveryCity") or "",
                "trackingCode": row.get("tracking_code") or raw.get("trackingCode") or "",
                "port": raw.get("port") or "",
                "logisticsCarrier": raw.get("logisticsCarrier") or "",
                "internalComments": raw.get("internalComments") or "",
                "freightTotal": to_float(raw.get("freightTotal")),
                "createdBy": raw.get("createdBy"),
                "invoiceDate": raw.get("invoiceDate"),
                "supplierInvoiceReference": raw.get("supplierInvoiceReference") or "",
                "items": items,
            }
        )
    return rows



def parse_date_key(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).date().isoformat()
    text = str(value).strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(text[:10], fmt).date().isoformat()
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return text


def days_between(from_date, to_date):
    if not from_date or not to_date:
        return None
    try:
        a = datetime.fromisoformat(str(from_date)).date()
        b = datetime.fromisoformat(str(to_date)).date()
        return (b - a).days
    except ValueError:
        return None


def po_history_key(po):
    if po.get("id"):
        return f"id:{po['id']}"
    return f"ref:{clean_reference(po.get('reference') or '')}"


def load_po_eta_history():
    for path in (PO_ETA_HISTORY_PATH, PO_ETA_HISTORY_BACKUP_PATH):
        try:
            parsed = json.loads(path.read_text())
            if isinstance(parsed, dict):
                parsed.setdefault("pos", {})
                return parsed
        except Exception:
            pass
    return {"version": 1, "generatedAt": None, "pos": {}}


def update_po_eta_history(purchase_orders, detected_at):
    history = load_po_eta_history()
    history["version"] = 1
    history["generatedAt"] = detected_at
    history.setdefault("pos", {})
    for po in purchase_orders:
        key = po_history_key(po)
        if not key or key == "ref:":
            continue
        current_eta = parse_date_key(po.get("estimatedArrivalDate") or po.get("arrival"))
        original_eta = parse_date_key((po.get("customFields") or {}).get("orders_1000"))
        received_date = parse_date_key(po.get("fullyReceivedDate"))
        record = history["pos"].get(key) or {
            "key": key,
            "id": po.get("id"),
            "reference": clean_reference(po.get("reference") or ""),
            "firstSeenAt": detected_at,
            "events": [],
        }

        def add_event(event_type, from_value, to_value, **extra):
            last = record["events"][-1] if record.get("events") else None
            if last and last.get("type") == event_type and last.get("from") == from_value and last.get("to") == to_value:
                return
            event = {"detectedAt": detected_at, "type": event_type, "from": from_value, "to": to_value}
            event.update(extra)
            record.setdefault("events", []).append(event)

        if key not in history["pos"]:
            if original_eta or current_eta:
                add_event(
                    "first_seen",
                    None,
                    current_eta or original_eta,
                    originalEta=original_eta,
                    currentEta=current_eta,
                    deltaDaysFromOriginal=days_between(original_eta, current_eta),
                )
        else:
            if record.get("currentEta") != current_eta:
                add_event(
                    "eta_changed",
                    record.get("currentEta"),
                    current_eta,
                    deltaDays=days_between(record.get("currentEta"), current_eta),
                    deltaDaysFromOriginal=days_between(original_eta or record.get("originalEta"), current_eta),
                )
            if record.get("originalEta") != original_eta:
                add_event("original_eta_changed", record.get("originalEta"), original_eta)
            if record.get("receivedDate") != received_date and received_date:
                add_event(
                    "received",
                    record.get("receivedDate"),
                    received_date,
                    deltaDaysFromOriginal=days_between(original_eta or record.get("originalEta"), received_date),
                )

        record.update({
            "id": po.get("id"),
            "reference": clean_reference(po.get("reference") or ""),
            "supplier": po.get("company") or record.get("supplier") or "",
            "stage": po.get("stage") or "",
            "status": po.get("status") or "",
            "deliveryCountry": po.get("deliveryCountry") or record.get("deliveryCountry") or "",
            "originalEta": original_eta,
            "currentEta": current_eta,
            "receivedDate": received_date,
            "lastSeenAt": detected_at,
        })
        history["pos"][key] = record
    PO_ETA_HISTORY_PATH.write_text(json.dumps(history, default=json_default, indent=2))
    PO_ETA_HISTORY_BACKUP_PATH.write_text(json.dumps(history, default=json_default, indent=2))
    return history

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    existing = load_existing_snapshot()
    with connect() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            products, stock_by_branch = build_products_and_stock(cur)
            purchase_orders = build_purchase_orders(cur)
            latest_core = fetch_one(
                cur,
                """
                select max(last_successful_window_end)
                from sync.entity_checkpoints
                where entity in ('branches','products','product_options_endpoint','stock','purchase_orders')
                """,
            )
            latest_products = fetch_one(
                cur,
                """
                select max(last_successful_window_end)
                from sync.entity_checkpoints
                where entity in ('branches','products','product_options_endpoint','stock')
                """,
            )
            latest_pos = fetch_one(
                cur,
                """
                select max(last_successful_window_end)
                from sync.entity_checkpoints
                where entity = 'purchase_orders'
                """,
            )

    if not products or not purchase_orders:
        raise SystemExit(f"Refusing to write empty mirror snapshot: products={len(products)} pos={len(purchase_orders)}")

    snapshot_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    mirror_ts = iso(latest_core) or snapshot_ts
    product_ts = iso(latest_products) or mirror_ts
    po_ts = iso(latest_pos) or mirror_ts

    snapshot = {
        **existing,
        "snapshotCreatedAt": snapshot_ts,
        "lastSnapshotWrite": snapshot_ts,
        "lastRefresh": mirror_ts,
        "lastCin7Refresh": product_ts,
        "lastPoRefresh": po_ts,
        "cin7Products": products,
        "cin7StockByBranch": stock_by_branch,
        "cin7POs": purchase_orders,
        "shopifyVelocity": existing.get("shopifyVelocity", {}),
        "shopifyVelocityByCountry": existing.get("shopifyVelocityByCountry", {}),
        "shopifyInventory": existing.get("shopifyInventory", {}),
        "shopifyOpenDemand": existing.get("shopifyOpenDemand", {}),
        "error": None,
        "cin7Source": "local-mirror-postgres",
        "cin7MirrorExportedAt": snapshot_ts,
    }
    po_snapshot = {
        "lastRefresh": mirror_ts,
        "lastCin7Refresh": product_ts,
        "lastPoRefresh": po_ts,
        "cin7POs": purchase_orders,
        "cin7Source": "local-mirror-postgres",
        "cin7MirrorExportedAt": snapshot_ts,
    }

    print(f"Mirror snapshot ready: {len(products):,} SKUs, {len(purchase_orders):,} POs, mirror_ts={mirror_ts}")
    if args.dry_run:
        return

    eta_history = update_po_eta_history(purchase_orders, snapshot_ts)
    print(f"Updated PO ETA history for {len(eta_history.get('pos', {})):,} POs")

    CACHE_PATH.write_text(json.dumps(snapshot, default=json_default, separators=(",", ":")))
    CACHE_BACKUP_PATH.write_text(json.dumps(snapshot, default=json_default, separators=(",", ":")))
    PO_PATH.write_text(json.dumps(po_snapshot, default=json_default, separators=(",", ":")))
    PO_BACKUP_PATH.write_text(json.dumps(po_snapshot, default=json_default, separators=(",", ":")))
    print(f"Wrote {CACHE_PATH} and {PO_PATH}")


if __name__ == "__main__":
    main()
