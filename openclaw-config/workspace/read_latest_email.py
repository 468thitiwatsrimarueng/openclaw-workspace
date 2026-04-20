#!/usr/bin/env python3
"""Read the latest email from Gmail using the provided OAuth credentials.

Prerequisites:
  - Install required packages:
      pip install --upgrade google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client
  - Ensure the OAuth client credentials file is named ``credentials.json``
    and placed in the same directory as this script.
  - The first time you run the script a browser window will open for you to
    authorize access to your Gmail account. A token will be saved to
    ``token.json`` for subsequent runs.
"""

import os.path
import base64
import sys
from email import policy
from email.parser import BytesParser

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# If modifying these scopes, delete the file token.json.
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

def get_service():
    """Creates a Gmail API service after handling authentication."""
    creds = None
    # token.json stores the user's access and refresh tokens, and is
    # created automatically when the authorization flow completes for the first time.
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    # If there are no (valid) credentials available, let the user log in.
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        # Save the credentials for the next run
        with open('token.json', 'w') as token:
            token.write(creds.to_json())
    return build('gmail', 'v1', credentials=creds)


def get_latest_email(service):
    # Retrieve the list of message IDs, ordered by most recent first.
    result = service.users().messages().list(userId='me', maxResults=1, q='').execute()
    messages = result.get('messages', [])
    if not messages:
        print('No messages found.')
        return
    msg_id = messages[0]['id']
    # Get the full message details
    msg = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
    # Decode the email payload
    payload = msg.get('payload', {})
    headers = payload.get('headers', [])
    # Extract useful headers
    subject = next((h['value'] for h in headers if h['name'] == 'Subject'), '(No Subject)')
    from_header = next((h['value'] for h in headers if h['name'] == 'From'), '(No Sender)')
    # Get the body (plain text part)
    parts = payload.get('parts', [])
    body = ''
    for part in parts:
        if part.get('mimeType') == 'text/plain':
            data = part.get('body', {}).get('data')
            if data:
                body = base64.urlsafe_b64decode(data.encode('UTF-8')).decode('utf-8')
                break
    # Fallback to snippet if no body found
    if not body:
        body = msg.get('snippet', '')
    print('Subject:', subject)
    print('From:', from_header)
    print('Body:', body)

if __name__ == '__main__':
    service = get_service()
    get_latest_email(service)
