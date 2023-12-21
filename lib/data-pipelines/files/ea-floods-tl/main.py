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


def transform(df) -> pd.DataFrame:
    string_cols = ['@id', 'description', 'eaAreaName', 'floodAreaID', 'message', 'severity']
    bool_cols = ['isTidal']
    timestamp_cols = ['timeMessageChanged', 'timeRaised', 'timeSeverityChanged']
    int_cols = ['severityLevel']

    df[string_cols] = df[string_cols].astype('string')
    df[bool_cols] = df[bool_cols].astype(bool)
    df[timestamp_cols] = df[timestamp_cols].apply(pd.to_datetime, format='%Y-%m-%dT%H:%M:%S')
    df[int_cols] = df[int_cols].astype(int)
    df['description'] = df['description'].apply(lambda x: x.strip())
    df['message'] = df['message'].apply(lambda x: x.strip())

    return df


def handler(event, context) -> dict:
    # Handle input received from State Machine
    sm_input = event['Payload']
    dataset_provider = sm_input['datasetProvider'].lower()
    dataset_name = sm_input['datasetName'].lower()

    data = get_data(s3_client, sm_input['rawBucket'], sm_input['rawKey'])['Body'].read()
    df = pd.DataFrame(json.loads(data)['items'])
    df = df[df.columns.difference(['eaRegionName', 'floodArea'])]
    df = transform(df.copy())
    wr.s3.to_parquet(
        df,
        f's3://{sm_input["dataLakeBucket"]}/{dataset_provider}/{dataset_name}.parquet',
        dataset=True,
        mode='overwrite',
        database=sm_input['dataLakeDatabaseName'],
        table=f'{dataset_provider}_{dataset_name}'
    )

    return {
        'rowsProcessed': len(df)
    }
