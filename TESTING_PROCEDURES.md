# Testing Procedures for hb Task Server

## Registration
1. Register with the following:
    username = alan456
    password = TestingAccount 
    email = johnsonalan006@gmail.com

2. Run npm run get-verify-url — prints the URL straight from the DB
3. Paste it in the browser to complete verification
4. When done testing, run npm run delete-test-user to reset

The script also accepts a username or email as an argument if you ever need a different account:

    ```
    npm run get-verify-url -- someusername
    ```

## Stripe testing information
| Field	| Value
|---|---|
| Card number	| 4242 4242 4242 4242
| Expiry    | Any future date (e.g. 12/34)
| CVC	| Any 3 digits (e.g. 123)
| ZIP	| Any 5 digits (e.g. 12345)

Other useful test cards:

| Scenario	| Card number
|---|---|
| Visa (success)	| 4242 4242 4242 4242
| Mastercard (success)	| 5555 5555 5555 4444
| Requires authentication (3D Secure)	| 4000 0025 0000 3155
| Card declined	| 4000 0000 0000 9995
| Insufficient funds	| 4000 0000 0000 9995
| Expired card	| 4000 0000 0000 0069

For the free trial plan, Stripe still collects card info (to charge after the trial ends) — use 4242 4242 4242 4242 for that too.

All of these only work when your STRIPE_SECRET_KEY starts with sk_test_ .

