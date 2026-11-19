#!/usr/bin/env bash
# End-to-end check of accounts + reading history against a running server. Usage: test/api-smoke.sh [base-url]
set -e
B=${1:-http://localhost:3000}
C=$(mktemp)
E="smoke$(date +%s%N)@example.com"
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }
echo "register:  $(curl -s -c $C -H 'Content-Type: application/json' -d "{\"email\":\"$E\",\"password\":\"password123\",\"name\":\"Smoke\"}" $B/api/auth/register | j 'o.user?.email||o.error')"
echo "duplicate: $(curl -s -H 'Content-Type: application/json' -d "{\"email\":\"${E^^}\",\"password\":\"password123\"}" $B/api/auth/register | j 'o.error')"
echo "me:        $(curl -s -b $C $B/api/auth/me | j 'o.user?.email')"
curl -s -b $C -X PUT -H 'Content-Type: application/json' -d '{"state":"CA","theme":"dark"}' $B/api/settings >/dev/null
T=$(node -e 'console.log(Date.now())')
curl -s -b $C -X PUT -H 'Content-Type: application/json' -d "{\"items\":[{\"src\":\"oul\",\"id\":\"A\",\"title\":\"Doc A\",\"progress\":0.5,\"anchor\":7,\"updatedAt\":$T},{\"src\":\"oul\",\"id\":\"B\",\"title\":\"Doc B\",\"progress\":0.2,\"updatedAt\":$((T-1000))}]}" $B/api/history >/dev/null
curl -s -b $C -X PUT -H 'Content-Type: application/json' -d "{\"src\":\"oul\",\"id\":\"A\",\"title\":\"Doc A\",\"progress\":0.1,\"updatedAt\":$((T-5000))}" $B/api/history >/dev/null
echo "history:   $(curl -s -b $C $B/api/history | j "o.items.map(i=>i.key+'@'+i.progress+'#'+i.anchor).join(', ')")   (A must stay 0.5: stale write ignored)"
curl -s -b $C -X DELETE "$B/api/history?key=oul:B" >/dev/null
echo "after del: $(curl -s -b $C $B/api/history | j "o.items.map(i=>i.key).join(', ')")"
curl -s -b $C -X POST $B/api/auth/logout >/dev/null
echo "logout:    $(curl -s -b $C $B/api/auth/me | j 'String(o.user)')"
echo "login:     $(curl -s -c $C -H 'Content-Type: application/json' -d "{\"email\":\"$E\",\"password\":\"password123\"}" $B/api/auth/login | j "o.user.email+' settings='+JSON.stringify(o.user.settings)")"
echo "bad pw:    $(curl -s -H 'Content-Type: application/json' -d "{\"email\":\"$E\",\"password\":\"wrongpass1\"}" $B/api/auth/login | j 'o.error')"
rm -f $C
