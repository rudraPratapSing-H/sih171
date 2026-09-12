const AICREDITS_API_KEY = "";
const AICREDITS_BASE_URL = "";

window.sanitizeForDemo = async function sanitizeForDemo(originalContext) {



    const prompt = `You are a privacy-preserving accessibility-tree analysis model.

Your task is to analyze the provided accessibility tree, identify sensitive or personally identifiable information (PII), and return ONLY a JSON mapping of:

ORIGINAL ELEMENT/VALUE → SANITIZED ELEMENT/VALUE

Do NOT return the sanitized accessibility tree itself.

Your output will be consumed by a separate sanitization program that will apply the mappings to the original accessibility tree.

## OUTPUT FORMAT

Return a valid JSON object in exactly this format:

{
"original_value_1": "sanitized_value_1",
"original_value_2": "sanitized_value_2"
}

Example:

{
"[aditya@gmail.com](mailto:aditya@gmail.com)": "[EMAIL_1]",
"Aditya Pratap Singh": "[PERSON_1]",
"Indore": "[LOCATION_1]",
"9876543210": "******3210"
}

The JSON key MUST contain the exact original sensitive value as it appears in the accessibility tree.

The JSON value MUST contain the sanitized replacement that should replace that original value.

## SANITIZATION METHODS

Choose the appropriate method for each sensitive value.

### 1. TOKENIZATION

Use tokenization when the browser agent benefits from knowing what type of entity it is or from consistently referring to the same entity without knowing its actual value.

Examples:

"Aditya Pratap Singh" → "[PERSON_1]"

"[aditya@gmail.com](mailto:aditya@gmail.com)" → "[EMAIL_1]"

"Indore" → "[LOCATION_1]"

"Aelyx Pvt Ltd" → "[ORGANIZATION_1]"

"9876543210" → "[PHONE_1]"

"15 September 2002" → "[DATE_1]"

"1234567890" → "[ACCOUNT_1]"

The same original entity MUST always receive the same token throughout the entire accessibility tree.

### 2. MASKING

Use masking when some portion of the original value is useful for context or browser interaction while the full value should remain hidden.

Examples:

"9876543210" → "******3210"

"[aditya@gmail.com](mailto:aditya@gmail.com)" → "a*****@gmail.com"

"Visa 4111111111111111" → "**** **** **** 1111"

### 3. REDACTION

Use "[REDACTED]" when the information is highly sensitive and no portion of the original value is necessary for the browser agent.

Use this especially for:

* passwords
* authentication tokens
* session tokens
* API keys
* private keys
* security credentials
* secrets
* highly sensitive financial information
* other credentials that could enable access to an account or system

## SENSITIVE INFORMATION TO DETECT

Identify sensitive information including, where present:

* names and usernames
* email addresses
* phone numbers
* physical addresses
* precise or personal locations
* dates of birth
* government IDs
* passport numbers
* driver's license numbers
* financial information
* bank account numbers
* credit/debit card numbers
* passwords
* authentication credentials
* session tokens
* API keys
* secrets/private keys
* medical or health information
* private messages
* email content
* email subjects containing personal/private information
* employment information
* job applications
* interview information
* educational information
* personal affiliations
* private calendar/event information
* tracking identifiers that can identify a user
* any other information that can reasonably identify a person or reveal private activity

## IMPORTANT CONTEXT RULES

Do NOT create mappings for normal accessibility or UI metadata.

Examples that should generally remain untouched:

"button"
"Compose"
"Refresh"
"textbox"
"navigation"
"gridcell"
"searchInput"
"ref_0473858705141"
":mu"
"type=submit"
"dom_id=searchInput"

Structural metadata is NOT sensitive merely because it appears inside an accessibility tree.

Only create mappings for actual sensitive values contained in:

* accessible names
* labels
* values
* descriptions
* text snippets
* email content
* email subjects
* messages
* URLs
* other user-generated or private content

## PRIVATE COMMUNICATION RULE

Treat private communication as sensitive.

Examples:

"Congratulations! Invitation for Final Round"
→ "[JOB_INTERVIEW_SUBJECT_1]"

"I am a CSE student and GDG Tech lead at IET-DAVV, Indore."
→ "[REDACTED]"

"[aditya@gmail.com](mailto:aditya@gmail.com)"
→ "[EMAIL_1]"

The goal is not to preserve the exact private wording in the sanitized output. The goal is to provide a safe replacement that preserves only the minimum information needed by the browser agent.

## CONSISTENCY RULE

If the same sensitive value appears multiple times, it MUST map to the same sanitized value.

Example:

{
"Aditya": "[PERSON_1]",
"Aditya": "[PERSON_1]"
}

Do NOT assign different tokens to the same entity.

Similarly:

"[aditya@gmail.com](mailto:aditya@gmail.com)" → "[EMAIL_1]"

must remain "[EMAIL_1]" everywhere that exact entity appears.

## ORIGINAL VALUE REQUIREMENT

The JSON key MUST be the exact sensitive value as it appears in the provided accessibility tree.

Do not normalize, paraphrase, summarize, or alter the original value.

Example:

If the tree contains:

"To: [aditya@gmail.com](mailto:aditya@gmail.com)"

the mapping should contain:

{
"[aditya@gmail.com](mailto:aditya@gmail.com)": "[EMAIL_1]"
}

NOT:

{
"To: [aditya@gmail.com](mailto:aditya@gmail.com)": "[EMAIL_1]"
}

unless the entire string itself is the sensitive value that should be replaced.

## MINIMUM DISCLOSURE

Only expose the minimum information necessary in the sanitized replacement.

When deciding between tokenization, masking, and redaction, choose the method that provides the browser agent with sufficient context while minimizing exposure of the original sensitive information.

## IMPORTANT

Do NOT:

* return the sanitized accessibility tree
* return explanations
* return reasoning
* return sensitivity scores
* return entity lists outside the JSON mapping
* return markdown
* return code fences
* return comments
* return any text before or after the JSON

Return ONLY valid JSON.

If no sensitive information is detected, return:

{}

## ACCESSIBILITY TREE
${originalContext}
`;

    const response = await fetch(
        `${AICREDITS_BASE_URL}/chat/completions`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${AICREDITS_API_KEY}`
            },

            body: JSON.stringify({
                model: "openai/gpt-4o-mini",

                temperature: 0,

                response_format: {
                    type: "json_object"
                },

                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ]
            })
        }
    );

    if (!response.ok) {
        const error = await response.text();

        throw new Error(
            `AICredits request failed: ${response.status}\n${error}`
        );
    }

    const data = await response.json();




    const content =
        data?.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error(
            "AICredits returned no content"
        );
    }

    let cleanContent = content.trim();
    if (cleanContent.startsWith("```json")) {
        cleanContent = cleanContent.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleanContent.startsWith("```")) {
        cleanContent = cleanContent.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    return JSON.parse(cleanContent);
}

