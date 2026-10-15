# Echolink ControlPoint

Project controls intelligence for Primavera P6 schedules.

## Files
- controlpoint.html: the complete app in one file. Open it in any browser.
- app.html: page template (layout, styles, views, AI and export logic)
- engine.js: analytics engine (XER parser, CPM, DCMA 14, earned value, Monte Carlo)
- gen.js: generates the Northgate Distribution Center sample (northgate.xer)
- northgate.xer: sample P6 schedule
- logo.png: Echolink logo with a transparent background
- build.py: assembles controlpoint.html from the pieces above

## Rebuild
    node gen.js        # only if you change the sample project
    python3 build.py

## Notes
- The AI analyst and file downloads use Claude artifact capabilities (window.claude).
  Outside Claude the app still runs fully, and the status narrative falls back to the
  built-in rules engine. To host it on your own site with AI, replace the calls to
  S.caps.sample with calls to your own server endpoint that calls the Claude API.
- Dates use a five day working calendar. Planned dates in the XER serve as the baseline.
