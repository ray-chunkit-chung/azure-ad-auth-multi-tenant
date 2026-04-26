terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "rcoauth2azure-terraform-state"
    key            = "backend/terraform.tfstate"
    region         = "ap-northeast-1"
    dynamodb_table = "rcoauth2azure-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {}

data "aws_region" "current" {}
