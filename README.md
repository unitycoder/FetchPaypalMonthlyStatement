<img src="https://img.shields.io/badge/VibeCoded-100%25-green" alt="AI Generated Content"/>

# Fetch Paypal Monthly Statement (with node.js)
Fetch paypal monthly statement using Paypal API and output PDF report (similar to paypal's own report).
Its total disaster how bad the Paypal website is, you have to spend 10-30 minutes to get that report manually and earlier this year they even removed the automatic monthly statement (you still had to request it in the list, but at least it was automatically set per month), now you have to manually select the start and ending dates!!1

### Setup
- go to https://developer.paypal.com/api/rest/
- create new app in api..place
- adjust permissions (only need the access to reports/transactions)
- then copy client id and secret and place them into secrets/secret.json (can rename secret.template.json to secret.json and fill the details there)
- then run the script with "run.bat" or "node index.js"
- pdf report is saved into Reports/ folder
- Adjust year and month in the index.js script *or make it as an argument yourself
