#!/usr/bin/env python3
"""
Scrape Sacramento-area golf course scorecards from Greenskeeper.org.
Outputs a ready-to-paste COURSE_DB JavaScript array.
"""

import requests
from bs4 import BeautifulSoup
import json
import time
import re

BASE = "https://www.greenskeeper.org/northern_california/sacramento_area"

# Course name, Greenskeeper slug, lat, lng (pre-looked-up from Google Maps)
COURSES = [
    ("Ancil Hoffman", "Ancil_Hoffman_Golf_Course", 38.6358, -121.3283),
    ("Antelope Greens", "antelope_greens_golf_course", 38.7083, -121.3597),
    ("Bartley Cavanaugh", "Bartley_Cavanaugh_Golf_Course", 38.4857, -121.5047),
    ("Bing Maloney", "Bing_Maloney_Golf_Course_18", 38.5063, -121.4930),
    ("Black Oak", "Black_Oak_Golf_Course", 38.0641, -120.7322),
    ("Brookside CC", "brookside_country_club", 38.5622, -121.4200),
    ("Cherry Island", "Cherry_Island_Golf_Course", 38.5884, -121.5535),
    ("Cordova", "cordova_golf_course_sacramento", 38.5892, -121.2801),
    ("Dry Creek Ranch", "Dry_Creek_Ranch_Golf_Course", 38.6200, -121.2286),
    ("Haggin Oaks (Arcade Creek)", "Haggin_Oaks_Golf_Course_Arcade_Creek", 38.6176, -121.4313),
    ("Haggin Oaks (MacKenzie)", "Haggin_Oaks_Golf_Course_Mackenzie", 38.6176, -121.4313),
    ("Mather", "Mather_Golf_Course", 38.5539, -121.2897),
    ("Rancho Murieta CC (North)", "rancho_murieta_country_club", 38.5039, -121.0942),
    ("Rancho Murieta CC (South)", "rancho_murieta_country_club_south", 38.4983, -121.0900),
    ("Teal Bend", "Teal_Bend_Golf_Club", 38.6167, -121.5250),
    ("Turkey Creek", "Turkey_Creek_Golf_Club", 38.7478, -121.1756),
    ("Whitney Oaks", "Whitney_Oaks_Golf_Club", 38.7364, -121.2028),
    ("Winchester CC", "winchester_country_club_sacramento", 38.5861, -121.3786),
    ("Woodcreek", "Woodcreek_Golf_Course", 38.7353, -121.2758),
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
}

def parse_scorecard(html):
    """Extract par and handicap arrays from a Greenskeeper scorecard page."""
    soup = BeautifulSoup(html, 'html.parser')

    # Find all tables on the page
    tables = soup.find_all('table')

    par = []
    hcp = []

    for table in tables:
        rows = table.find_all('tr')
        for row in rows:
            cells = row.find_all(['td', 'th'])
            if not cells:
                continue

            label = cells[0].get_text(strip=True).lower()

            # Look for par row (men's par only, not women's)
            if "men" in label and "women" not in label and "par" in label:
                values = []
                for cell in cells[1:]:
                    txt = cell.get_text(strip=True)
                    if txt.isdigit():
                        values.append(int(txt))
                if len(values) == 9:
                    par.extend(values)

            # Look for handicap row (men's only, not women's)
            if "men" in label and "women" not in label and ("hdcp" in label or "hcp" in label):
                values = []
                for cell in cells[1:]:
                    txt = cell.get_text(strip=True)
                    if txt.isdigit():
                        values.append(int(txt))
                if len(values) == 9:
                    hcp.extend(values)

    return par, hcp

def main():
    results = []
    errors = []

    for name, slug, lat, lng in COURSES:
        url = f"{BASE}/{slug}/scorecard.cfm"
        print(f"Fetching {name}...", end=" ", flush=True)

        try:
            resp = requests.get(url, headers=HEADERS, timeout=15)
            resp.raise_for_status()

            par, hcp = parse_scorecard(resp.text)

            if len(par) == 18 and len(hcp) == 18:
                results.append({
                    "name": name,
                    "lat": lat,
                    "lng": lng,
                    "par": par,
                    "hcp": hcp
                })
                print(f"OK  par={par}  hcp={hcp}")
            else:
                errors.append(f"{name}: got {len(par)} par values, {len(hcp)} hcp values")
                print(f"INCOMPLETE (par={len(par)}, hcp={len(hcp)})")

                # Debug: dump table structure
                soup = BeautifulSoup(resp.text, 'html.parser')
                for table in soup.find_all('table'):
                    for row in table.find_all('tr'):
                        cells = row.find_all(['td', 'th'])
                        if cells:
                            label = cells[0].get_text(strip=True)
                            if 'par' in label.lower() or 'hdcp' in label.lower() or 'hcp' in label.lower():
                                vals = [c.get_text(strip=True) for c in cells[1:]]
                                print(f"    Found row: '{label}' -> {vals}")

        except Exception as e:
            errors.append(f"{name}: {e}")
            print(f"ERROR: {e}")

        time.sleep(1)  # polite delay

    # Output JS
    print("\n\n// === PASTE THIS INTO index.html ===")
    print("const COURSE_DB = [")
    for c in results:
        print(f'  {{name:"{c["name"]}",lat:{c["lat"]},lng:{c["lng"]},par:{json.dumps(c["par"])},hcp:{json.dumps(c["hcp"])}}},')
    print("];")

    if errors:
        print(f"\n// ERRORS ({len(errors)}):")
        for e in errors:
            print(f"//   {e}")

if __name__ == "__main__":
    main()
