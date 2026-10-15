# Builds controlpoint.html from the template, engine, sample schedule and logo.
# Usage: python3 build.py   (run gen.js first with node if you change the sample)
import json, base64
s = open("app.html").read()
logo = base64.b64encode(open("logo.png", "rb").read()).decode()
s = (s.replace("/*ENGINE*/", open("engine.js").read())
      .replace("/*SAMPLE*/", json.dumps(open("northgate.xer").read()))
      .replace("/*LOGO*/", "data:image/png;base64," + logo))
open("controlpoint.html", "w").write(s)
print("Built controlpoint.html,", len(s), "bytes")
