from __future__ import annotations

import argparse
import csv
import io
import json
import urllib.request
import zipfile
from pathlib import Path

MASTER_BASE = "https://new.real.download.dws.co.kr/common/master/"
KR_FILES = [
    ("kospi", "코스피", "kospi_code.mst.zip"),
    ("kosdaq", "코스닥", "kosdaq_code.mst.zip"),
    ("konex", "코넥스", "konex_code.mst.zip"),
]
US_FILES = [
    ("NAS", "나스닥", "nasmst.cod.zip"),
    ("NYS", "뉴욕증권거래소", "nysmst.cod.zip"),
    ("AMS", "아멕스", "amsmst.cod.zip"),
]
KR_EQUITY_GROUPS = {"ST", "FS", "DR", "RT", "IF"}


def fetch_zip(filename: str, source_dir: Path | None) -> bytes:
    if source_dir:
        path = source_dir / filename
        return path.read_bytes()
    request = urllib.request.Request(
        MASTER_BASE + filename,
        headers={"User-Agent": "CampusLeagueSymbolCatalog/1.0"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def unzip_first(data: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files = [name for name in archive.namelist() if not name.endswith("/")]
        if not files:
            raise ValueError("Master ZIP is empty")
        return archive.read(files[0])


def parse_kr(filename: str, exchange: str, exchange_name: str, source_dir: Path | None):
    payload = unzip_first(fetch_zip(filename, source_dir))
    symbols = []
    for line in payload.splitlines():
        if len(line) < 63:
            continue
        code = line[0:9].decode("cp949", errors="ignore").strip()
        if len(code) > 6:
            code = code[-6:]
        name = line[21:61].decode("cp949", errors="ignore").strip()
        group = line[61:63].decode("ascii", errors="ignore").strip()
        if not code or not name or group not in KR_EQUITY_GROUPS:
            continue
        symbols.append({
            "symbol": code,
            "name": name,
            "english_name": "",
            "market": "KR",
            "exchange": exchange,
            "exchange_name": exchange_name,
            "currency": "KRW",
            "asset_type": group,
        })
    return symbols


def parse_us(filename: str, exchange: str, exchange_name: str, source_dir: Path | None):
    payload = unzip_first(fetch_zip(filename, source_dir))
    symbols = []
    for raw_line in payload.splitlines():
        try:
            fields = raw_line.decode("cp949").rstrip("\r").split("\t")
        except UnicodeDecodeError:
            continue
        if len(fields) < 18 or fields[2].strip() != exchange:
            continue
        symbol = fields[4].strip().upper()
        korean_name = fields[6].strip()
        english_name = fields[7].strip()
        stock_type = fields[8].strip()
        suspended = fields[17].strip().upper() == "Y"
        if not symbol or stock_type != "2" or suspended:
            continue
        symbols.append({
            "symbol": symbol,
            "name": korean_name or english_name,
            "english_name": english_name,
            "market": "US",
            "exchange": exchange,
            "exchange_name": exchange_name,
            "currency": "USD",
            "asset_type": "COMMON",
        })
    return symbols


def write_tsv(path: Path, symbols: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["symbol", "name", "english_name", "market", "exchange", "exchange_name", "currency", "asset_type"]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        for row in symbols:
            clean = {key: str(row.get(key, "")).replace("\t", " ").replace("\r", " ").replace("\n", " ") for key in fields}
            writer.writerow(clean)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("data"))
    args = parser.parse_args()
    kr = []
    us = []
    for exchange, name, filename in KR_FILES:
        kr.extend(parse_kr(filename, exchange, name, args.source_dir))
    for exchange, name, filename in US_FILES:
        us.extend(parse_us(filename, exchange, name, args.source_dir))
    def unique(rows):
        seen = set()
        result = []
        for row in rows:
            key = (row["market"], row["exchange"], row["symbol"])
            if key in seen:
                continue
            seen.add(key)
            result.append(row)
        return sorted(result, key=lambda row: (row["name"].casefold(), row["symbol"]))
    kr, us = unique(kr), unique(us)
    def write_chunks(market: str, rows: list[dict], chunk_size: int = 1500) -> list[str]:
        prefix = f"stocks-{market.lower()}-"
        for old_file in args.output_dir.glob(prefix + "*.tsv"):
            old_file.unlink()
        filenames = []
        for offset in range(0, len(rows), chunk_size):
            filename = f"{prefix}{offset // chunk_size + 1:02d}.tsv"
            write_tsv(args.output_dir / filename, rows[offset:offset + chunk_size])
            filenames.append(filename)
        return filenames

    args.output_dir.mkdir(parents=True, exist_ok=True)
    kr_files = write_chunks("kr", kr)
    us_files = write_chunks("us", us)
    manifest = {
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "markets": {
            "KR": {"count": len(kr), "files": kr_files},
            "US": {"count": len(us), "files": us_files},
        },
        "source": "KIS public security master files",
    }
    (args.output_dir / "stocks-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "KR": {"count": len(kr), "files": len(kr_files)},
        "US": {"count": len(us), "files": len(us_files)},
        "sources": "KIS public security master files",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()


