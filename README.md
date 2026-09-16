# Sentinel ER

The hospital knows what's coming — in the next hour, the next three days, and for the patients in
its community who can't survive the outage.

Sentinel ER is a console for a hospital's emergency department and its incident commander. It has
three horizons:

- **Now.** A disaster is detected from public feeds. A trained model estimates casualties, and a
  surge forecast shows which nearby hospital fills first and when. A verified situation report
  follows, and after a human approves it, a conversational phone call pre-notifies the charge
  nurse.
- **Next 72 hours.** Expected change in ED visits from wildfire smoke, heat and storms, with
  staffing and stock suggestions.
- **Community.** Power-dependent Medicare patients by ZIP (HHS emPOWER, aggregate counts only),
  set against the chance their power goes out, so the county, equipment suppliers and shelters
  can be called first.

It runs on public data and never touches a patient record. Every number that leaves the system,
whether written or spoken, is checked against its source first.

Built for the 2nd Washington Hackathon 2026 (HealthTech & Bio-Innovation). All code in this
repository was written for the event, starting 16 September 2026. Every external library, API and
dataset is listed in [THIRD_PARTY.md](THIRD_PARTY.md).

Status: in progress.
