import json

def handler(event, context):
    print("event", event)
    return {
        'statusCode': 200,
        'body': json.dumps({'message': 'Hello, world!'})
    }
