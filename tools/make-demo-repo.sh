#!/bin/sh
# Builds a small local git repo whose history matches the mock failure log, so owner tagging can be demoed.
set -e
D="${1:-/tmp/radar-demo-repo}"
rm -rf "$D"
mkdir -p "$D/force-app/main/default/classes" "$D/force-app/main/default/objects/Claim__c/fields"
cd "$D"
git init -q -b main
c() { GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" git commit -q -m "$3"; }

echo "public class PaymentHelper {}" > force-app/main/default/classes/PaymentHelper.cls
git add -A; c "Marcus Lee" "marcus@example.com" "US-0000138 refactor PaymentHelper"

echo "public class PaymentCalculator {}" > force-app/main/default/classes/PaymentCalculator.cls
echo "@isTest public class PaymentCalculatorTest {}" > force-app/main/default/classes/PaymentCalculatorTest.cls
git add -A; c "Priya Nair" "priya@example.com" "US-0000142 use countNewMonths in calculator"

echo "<CustomField/>" > force-app/main/default/objects/Claim__c/fields/Appeal_Status__c.field-meta.xml
git add -A; c "Marcus Lee" "marcus@example.com" "US-0000151 add appeal status field"
echo "$D"
