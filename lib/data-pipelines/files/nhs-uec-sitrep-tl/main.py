from io import BytesIO
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
    df.drop(df.columns[2], axis=1, inplace=True)
    df.drop(df.columns[0], axis=1, inplace=True)
    df.drop(2, axis=0, inplace=True)

    df.insert(0, 'NHS England Region', df[('Unnamed: 1_level_0', 'NHS England Region')])
    df.insert(1, 'Code', df[('Unnamed: 3_level_0', 'Code')])
    df.insert(2, 'Name', df[('Unnamed: 4_level_0', 'Name')])

    df.drop(df.columns[3:6], axis=1, inplace=True)
    df = df.set_index(['Name', 'Code', 'NHS England Region']).stack(level=0)
    df.index.names = ['Name', 'Code', 'NHS England Region', 'Date']
    df = df.reset_index()

    df.columns = df.columns.str.strip()
    int_cols = ['Total G&A Beds Open',
                'Total G&A Beds Unavailable to non-covid admissions "void"',
                "Total G&A beds occ'd"]
    df[int_cols] = df[int_cols].astype(int)

    return df


def handler(event, context) -> dict:
    # Handle input received from State Machine
    sm_input = event['Payload']
    dataset_provider = sm_input['datasetProvider'].lower()
    dataset_name = sm_input['datasetName'].lower()

    data = get_data(s3_client, sm_input['rawBucket'], sm_input['rawKey'])['Body'].read()
    df = pd.read_excel(BytesIO(data), sheet_name="Total G&A beds", header=[13, 14])
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
