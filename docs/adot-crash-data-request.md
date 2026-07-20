# ADOT Statewide Crash Data (ALISS) — Request Package

Goal: statewide, all-severity Arizona crash records for the platform's hazard
scoring, replacing the city-by-city patchwork (Tempe / Phoenix / Tucson feeds).

## How ADOT handles these requests

- Arizona's statewide crash database is **ALISS** (Accident Location
  Identification Surveillance System), accessed through the **Arizona Crash
  Information System (ACIS)** data mart.
- One-time extracts go through ADOT's **Public Record Center** (public records
  request under A.R.S. § 39-121) — start at azdot.gov and search "Public
  Record Center", or email **crashrecords@azdot.gov**.
- **Ongoing/recurring access** requires executing a **Data Access Agreement**
  with ADOT (this is how local agencies pull their own crash data). Ask for it
  in the initial request — worst case they say the agreement is limited to
  public agencies and offer periodic extracts instead.
- Expect them to strip personal identifiers (names, addresses, license
  numbers) — that's fine; the platform only needs location, time, and severity.
- Phone (ADOT Risk Management / records): 602.712.7744.

## What we're asking for

| Item | Ask |
|---|---|
| Coverage | Statewide; Maricopa, Pima, and Pinal counties acceptable as a first delivery |
| Years | Five most recent complete years |
| Format | CSV or similar machine-readable extract |
| Fields | Incident ID, crash date/time, latitude/longitude, injury severity, total injuries, total fatalities, collision manner, junction relation, light/weather/surface conditions |
| Exclusions | No personal identifying information needed |
| Ongoing | Ask about Data Access Agreement / refresh cadence |

## Import plan once data arrives

Add a CSV importer entry to `server/src/importers.js` (`CRASH_SOURCES`) with
`id: 'az-adot-aliss'` mapping their column names — the schema above matches
what the registry already stores. Then retire the city feeds or keep them for
fresher city-level updates.

## Draft letter (fill bracketed items before sending)

Subject: Crash data request — statewide extract for traffic-safety routing platform

To the ADOT Traffic Records / Crash Records team:

I am requesting Arizona crash records under the Arizona Public Records Law
(A.R.S. § 39-121 et seq.) on behalf of [COMPANY NAME], an Arizona-based
[BRIEF DESCRIPTION, e.g., "fleet dispatch software company"]. We build
routing software that helps commercial drivers avoid historically
crash-prone corridors, and we use public crash data to score planned routes
for safety.

Specifically, I am requesting an extract from the ALISS/ACIS crash database
with the following scope:

- Coverage: statewide (if statewide is impractical, Maricopa, Pima, and
  Pinal counties would serve as a first delivery)
- Years: the five most recent complete years available
- Format: CSV or any machine-readable format
- Fields: incident identifier, crash date and time, latitude and longitude,
  injury severity, total injuries, total fatalities, collision manner,
  junction relation, and light/weather/surface conditions

We do not need — and would prefer excluded — any personal identifying
information such as names, dates of birth, addresses, or driver license
numbers. Location, time, and severity attributes are sufficient.

Additionally, since our safety scoring benefits from current data, I would
like to ask whether ongoing or periodic access is available to an
organization like ours — I understand ADOT executes Data Access Agreements
for ALISS/Safety Data Mart access, and we would be glad to complete any
required agreement or forms, and to cover applicable fees.

Please let me know if any part of this request needs to be narrowed or
submitted through a different channel.

Thank you,
[NAME]
[TITLE], [COMPANY NAME]
[PHONE]
[EMAIL]
