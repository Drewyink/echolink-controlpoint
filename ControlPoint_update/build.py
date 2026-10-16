# Builds index.html (the complete app) from the template, engine, sample schedules and logo.
# Usage: python3 build.py   (run gen.js first with node if you change the sample)
import json, base64
s = open("app.html").read()
logo = base64.b64encode(open("logo.png", "rb").read()).decode()
s = (s.replace("/*ENGINE*/", open("engine.js").read())
      .replace("/*SAMPLE_PREV*/", json.dumps(open("northgate_prev.xer").read()))
      .replace("/*SAMPLE*/", json.dumps(open("northgate.xer").read()))
      .replace("/*LOGO*/", "data:image/png;base64," + logo))
open("index.html", "w").write(s)
print("Built index.html,", len(s), "bytes")
