<img src="https://img.shields.io/badge/VibeCoded-99%25-green" alt="AI Generated Content"/>

# Fetch Paypal Monthly Statement
fetch paypal monthly statement using Paypal API and output PDF report (similar to paypal's own report, which is too much work to get manually..)

### Setup
- go to https://developer.paypal.com/api/rest/
- create new app in api..place
- adjust permissions (only need the access to reports/transactions)
- then copy client id and secret and place them into secrets/secret.json
- then run the script with "run.bat" or "node index.js"
- pdf report is saved into Reports/ folder
- Adjust year and month in the index.js script *or make it as an argument yourself
