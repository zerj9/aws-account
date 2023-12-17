import json
import awswrangler as wr
import boto3
import pandas as pd
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client
    from mypy_boto3_s3.type_defs import GetObjectOutputTypeDef

s3_client = boto3.client('s3')


def get_data(s3_client: 'S3Client', bucket: str, key: str) -> 'GetObjectOutputTypeDef':
    return s3_client.get_object(Bucket=bucket, Key=key)


def transform(df) -> None:
    string_cols = ['id', 'title', 'summary', 'trading_bloc', 'location', 'categories']
    bool_cols = ['is_resolved', 'caused_by_trading_bloc']
    date_cols = ['status_date']
    timestamp_cols = ['last_published_on', 'reported_on']
    object_cols = ['country']
    # Flatten the sectors column into a list
    df['sectors'] = df['sectors'].apply(lambda row: [item['name'] for item in row])

    df[string_cols] = df[string_cols].astype('string')
    df[bool_cols] = df[bool_cols].astype(bool)
    df[date_cols] = df[date_cols].apply(pd.to_datetime, format='%Y-%m-%d')
    df[timestamp_cols] = df[timestamp_cols].apply(pd.to_datetime, format='%Y-%m-%dT%H:%M:%S.%fZ')
    df[object_cols] = df[object_cols].astype(object)


def handler(event, context) -> dict:
    # Input received from State Machine
    sm_input = event['Payload']
    data = get_data(s3_client, sm_input['rawBucket'], sm_input['rawKey'])['Body'].read()
    df = pd.DataFrame(json.loads(data)['barriers'])
    transform(df)
    wr.s3.to_parquet(
        df,
        f's3://{sm_input["dataLakeBucket"]}/{sm_input["datasetProvider"]}/{sm_input["datasetName"]}.parquet',
        dataset=True,
        mode='overwrite',
        database=sm_input['dataLakeDatabaseName'],
        table=f'{sm_input["datasetProvider"]}_{sm_input["datasetName"]}'
    )

    return {
        'rowsProcessed': len(df)
    }
