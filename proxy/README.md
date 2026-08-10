# פרוקסי ל-RiseUp API

**צריך את זה רק אם הסנכרון הישיר נכשל** עם ההודעה "הקריאה נחסמה (CORS או אין רשת)".

הבעיה: ה-API של RiseUp נבנה לשימוש משרת (דרך שרת ה-MCP), ולא בהכרח מחזיר כותרות CORS
שמתירות לדפדפן לקרוא לו מדף HTML. אם הוא לא מתיר — הדפדפן חוסם את התשובה, ואי אפשר
לעקוף את זה מצד הלקוח. הפרוקסי הזה הוא שרת זעיר שיושב באמצע, מחזיק את הטוקן, ומחזיר
את אותו JSON עם הכותרות הנכונות.

בונוס: הטוקן האמיתי (`riseup_pat_…`) כבר לא נמצא בדפדפן בכלל.

## פריסה

```bash
cd proxy
npx wrangler deploy
npx wrangler secret put RISEUP_PAT    # הטוקן מ-input.riseup.co.il/developer/tokens
npx wrangler secret put APP_SECRET    # מחרוזת אקראית ארוכה שתמציא
```

## חיבור האפליקציה

בהגדרות שבאפליקציה:

| שדה | ערך |
|---|---|
| כתובת | `https://<worker>.workers.dev` |
| טוקן | הערך של `APP_SECRET` — **לא** ה-PAT |

## מה הוא עושה

- מעביר רק `GET /api/external/transactions` ו-`/api/external/budget`. כל נתיב אחר מקבל 404.
- מוסיף `Authorization: Bearer <RISEUP_PAT>` בצד השרת.
- דורש `Authorization: Bearer <APP_SECRET>` מהאפליקציה, בהשוואה בזמן קבוע. בלי זה כל
  מי שיודע את הכתובת יכול לקרוא את התנועות בחשבון.
- מחזיר `Access-Control-Allow-Origin` (ברירת מחדל `*`; אפשר לצמצם דרך `ALLOWED_ORIGIN`
  ב-`wrangler.toml` אם האפליקציה מוגשת מדומיין קבוע).

## הערה על תוקף

טוקני RiseUp פגים אחרי 30 יום כברירת מחדל. כשזה קורה תראה באפליקציה
"הטוקן נדחה (401)" — צור טוקן חדש והרץ `npx wrangler secret put RISEUP_PAT` שוב.
