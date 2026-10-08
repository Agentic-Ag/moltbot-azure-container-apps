-- ============================================================
-- Agentic Ag Network — shared listings columns on Farm_Products
-- Run once against [zerosumag] database, AFTER farm_products_migration.sql
--
-- Adds opt-in publishing flags so each dashboard controls which
-- products appear in the public Agentic Ag network registry
-- (consumed by the website farmyard marketplace via
-- GET /api/network/registry).
-- ============================================================

USE [zerosumag];
GO

-- ── Farm_Products: network sharing columns ────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Farm_Products') AND name = 'share_to_network')
BEGIN
    ALTER TABLE [dbo].[Farm_Products]
        ADD [share_to_network] BIT NOT NULL CONSTRAINT [DF_Farm_Products_share_to_network] DEFAULT 0;
    PRINT 'Added Farm_Products.share_to_network';
END
ELSE PRINT 'Farm_Products.share_to_network already exists — skipping';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Farm_Products') AND name = 'network_description')
BEGIN
    ALTER TABLE [dbo].[Farm_Products]
        ADD [network_description] NVARCHAR(512) NULL;
    PRINT 'Added Farm_Products.network_description';
END
ELSE PRINT 'Farm_Products.network_description already exists — skipping';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Farm_Products') AND name = 'network_image')
BEGIN
    ALTER TABLE [dbo].[Farm_Products]
        ADD [network_image] NVARCHAR(256) NULL;
    PRINT 'Added Farm_Products.network_image';
END
ELSE PRINT 'Farm_Products.network_image already exists — skipping';
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Farm_Products') AND name = 'network_updated_at')
BEGIN
    ALTER TABLE [dbo].[Farm_Products]
        ADD [network_updated_at] DATETIME2 NULL;
    PRINT 'Added Farm_Products.network_updated_at';
END
ELSE PRINT 'Farm_Products.network_updated_at already exists — skipping';
GO

PRINT 'Network sharing migration complete.';
GO
