-- Knowledge Base Tables for Red Dog
-- Stores structured information for Red Dog to search and answer questions

-- Knowledge Base Articles
CREATE TABLE reddog.KnowledgeArticles (
    articleId UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
    title NVARCHAR(500) NOT NULL,
    content NVARCHAR(MAX) NOT NULL,
    category NVARCHAR(100) NOT NULL,
    source NVARCHAR(200) NOT NULL,
    sourceUrl NVARCHAR(500),
    publishedDate DATETIME2,
    lastUpdated DATETIME2 DEFAULT GETUTCDATE(),
    tags NVARCHAR(MAX),
    isActive BIT DEFAULT 1,
    searchVector NVARCHAR(MAX), -- For full-text search optimization
    metadata NVARCHAR(MAX), -- JSON for additional structured data
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    createdBy NVARCHAR(200)
);

-- Knowledge Base Categories
CREATE TABLE reddog.KnowledgeCategories (
    categoryId INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(100) NOT NULL UNIQUE,
    description NVARCHAR(500),
    parentCategoryId INT NULL,
    displayOrder INT DEFAULT 0,
    isActive BIT DEFAULT 1,
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    FOREIGN KEY (parentCategoryId) REFERENCES reddog.KnowledgeCategories(categoryId)
);

-- Knowledge Base Search Log
CREATE TABLE reddog.KnowledgeSearchLog (
    searchId UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
    userId NVARCHAR(200),
    query NVARCHAR(1000) NOT NULL,
    resultsCount INT,
    articleIds NVARCHAR(MAX), -- Comma-separated list of matched article IDs
    responseProvided BIT,
    satisfactionRating INT NULL, -- 1-5 scale
    createdAt DATETIME2 DEFAULT GETUTCDATE()
);

-- Knowledge Base Feedback
CREATE TABLE reddog.KnowledgeFeedback (
    feedbackId UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
    articleId UNIQUEIDENTIFIER NOT NULL,
    userId NVARCHAR(200),
    feedbackType NVARCHAR(50) NOT NULL, -- 'helpful', 'not_helpful', 'inaccurate', 'suggestion'
    comment NVARCHAR(MAX),
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    FOREIGN KEY (articleId) REFERENCES reddog.KnowledgeArticles(articleId)
);

-- Create indexes for search performance
CREATE INDEX IX_KnowledgeArticles_Category ON reddog.KnowledgeArticles(category);
CREATE INDEX IX_KnowledgeArticles_Source ON reddog.KnowledgeArticles(source);
CREATE INDEX IX_KnowledgeArticles_PublishedDate ON reddog.KnowledgeArticles(publishedDate);
CREATE INDEX IX_KnowledgeArticles_IsActive ON reddog.KnowledgeArticles(isActive);
CREATE INDEX IX_KnowledgeSearchLog_UserId ON reddog.KnowledgeSearchLog(userId);
CREATE INDEX IX_KnowledgeSearchLog_CreatedAt ON reddog.KnowledgeSearchLog(createdAt);

-- Full-text search catalog (if supported by SQL Server edition)
-- CREATE FULLTEXT CATALOG reddogKnowledgeCatalog AS DEFAULT;

-- Full-text index on articles
-- CREATE FULLTEXT INDEX ON reddog.KnowledgeArticles(content, title, tags)
-- KEY INDEX PK_KnowledgeArticles ON reddog.KnowledgeArticles;

-- Insert default categories
INSERT INTO reddog.KnowledgeCategories (name, description, displayOrder) VALUES
('News', 'Latest news and updates from Agentic Ag', 1),
('Events', 'Agricultural events and field days', 2),
('Services', 'Information about Agentic Ag services', 3),
('Technology', 'IoT, sensors, and farm technology', 4),
('Sustainability', 'Carbon farming, biodiversity, and regenerative agriculture', 5),
('Marketplace', 'FarmG8 marketplace and trading information', 6),
('Agents', 'Information about AI agents (Red Dog, Trevor Tractor, Daisy Bell)', 7);
