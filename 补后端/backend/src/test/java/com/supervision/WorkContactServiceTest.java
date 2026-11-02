package com.supervision;

import com.supervision.dto.ReplyDTO;
import com.supervision.dto.WorkContactDTO;
import com.supervision.entity.WorkContact;
import com.supervision.exception.BusinessException;
import com.supervision.repository.WorkContactRepository;
import com.supervision.service.WorkContactService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDate;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@DisplayName("WorkContactService 单元测试")
class WorkContactServiceTest {

    @Mock
    private WorkContactRepository workContactRepository;

    @Mock private com.supervision.service.ProjectAccessService access;
    @Mock private com.supervision.service.AttachmentAccessService attachmentAccess;
    @Mock private com.supervision.service.DiaryReferenceService diaryReferences;
    @Mock private com.supervision.service.DiaryResourceResolver diaryResources;

    @org.junit.jupiter.api.BeforeEach
    void identity() {
        var user = new com.supervision.entity.User();
        user.setId(1L);
        lenient().when(access.currentUser()).thenReturn(user);
        lenient().when(diaryResources.load(eq("work-contacts"), anyLong(), eq(true)))
                .thenAnswer(call -> workContactRepository.findById(call.getArgument(1))
                        .orElseThrow(() -> new BusinessException("工作联系单不存在")));
    }

    @InjectMocks
    private WorkContactService workContactService;

    @Test
    void deniedProjectCannotCreate() {
        doThrow(new BusinessException(403, "无项目权限")).when(access).requireRead(1L);
        assertThrows(BusinessException.class, () -> workContactService.create(buildDTO()));
        verifyNoInteractions(workContactRepository, attachmentAccess);
    }

    private WorkContactDTO buildDTO() {
        WorkContactDTO dto = new WorkContactDTO();
        dto.setCode("LXD-20240101");
        dto.setProjectId(1L);
        dto.setContactDate(LocalDate.of(2024, 1, 1));
        dto.setAuthorId(1L);
        dto.setTitle("施工协调联系单");
        dto.setContent("请尽快安排施工人员到位");
        dto.setPriority("high");
        return dto;
    }

    private WorkContact buildExisting() {
        WorkContact contact = new WorkContact();
        contact.setId(1L);
        contact.setCode("LXD-20240101");
        contact.setProjectId(1L);
        contact.setContactDate(LocalDate.of(2024, 1, 1));
        contact.setAuthorId(1L);
        contact.setTitle("施工协调联系单");
        contact.setContent("请尽快安排施工人员到位");
        contact.setPriority("high");
        contact.setStatus("sent");
        return contact;
    }

    @Test
    @DisplayName("创建工作联系单 - 验证默认status=draft")
    void testCreateWorkContact() {
        WorkContactDTO dto = buildDTO();
        when(workContactRepository.findByCode(dto.getCode())).thenReturn(Optional.empty());
        when(workContactRepository.save(any(WorkContact.class))).thenAnswer(invocation -> {
            WorkContact contact = invocation.getArgument(0);
            contact.setId(1L);
            return contact;
        });

        WorkContact result = workContactService.create(dto);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
        assertEquals("LXD-20240101", result.getCode());
        assertEquals("施工协调联系单", result.getTitle());
        assertEquals("high", result.getPriority());
        verify(workContactRepository).save(any(WorkContact.class));
    }

    @Test
    @DisplayName("创建工作联系单 - 编号已存在应抛出BusinessException")
    void testCreateWithDuplicateCode() {
        WorkContactDTO dto = buildDTO();
        WorkContact existing = buildExisting();
        when(workContactRepository.findByCode(dto.getCode())).thenReturn(Optional.of(existing));

        BusinessException exception = assertThrows(BusinessException.class,
                () -> workContactService.create(dto));
        assertEquals("编号已存在", exception.getMessage());
        verify(workContactRepository, never()).save(any());
    }

    @Test
    @DisplayName("创建工作联系单 - 编号存在但status为inactive时允许创建")
    void testCreateWithInactiveCode() {
        WorkContactDTO dto = buildDTO();
        WorkContact inactiveContact = buildExisting();
        inactiveContact.setStatus("inactive");
        when(workContactRepository.findByCode(dto.getCode())).thenReturn(Optional.of(inactiveContact));
        when(workContactRepository.save(any(WorkContact.class))).thenAnswer(invocation -> {
            WorkContact contact = invocation.getArgument(0);
            contact.setId(2L);
            return contact;
        });

        WorkContact result = workContactService.create(dto);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
    }

    @Test
    @DisplayName("回复工作联系单 - sent状态可回复，验证status=replied")
    void testReplyWorkContact() {
        WorkContact contact = buildExisting();
        // buildExisting()已设置status=sent
        when(workContactRepository.findById(1L)).thenReturn(Optional.of(contact));
        when(workContactRepository.save(any(WorkContact.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ReplyDTO dto = new ReplyDTO();
        dto.setId(1L);
        dto.setReplyContent("已安排人员到位");

        WorkContact result = workContactService.reply(dto);

        assertNotNull(result);
        assertEquals("replied", result.getStatus());
        assertEquals("已安排人员到位", result.getReplyContent());
        assertNotNull(result.getReplyDate());
        assertEquals(LocalDate.now(), result.getReplyDate());
        verify(workContactRepository).save(any(WorkContact.class));
    }

    @Test
    @DisplayName("回复工作联系单 - 不存在的ID应抛出BusinessException")
    void testReplyNonExistentContact() {
        when(workContactRepository.findById(999L)).thenReturn(Optional.empty());

        ReplyDTO dto = new ReplyDTO();
        dto.setId(999L);
        dto.setReplyContent("回复内容");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> workContactService.reply(dto));
        assertEquals("工作联系单不存在", exception.getMessage());
        verify(workContactRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新工作联系单 - 正常更新")
    void testUpdateWorkContact() {
        WorkContact existing = buildExisting();
        when(workContactRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(workContactRepository.save(any(WorkContact.class))).thenAnswer(invocation -> invocation.getArgument(0));

        WorkContactDTO dto = buildDTO();
        dto.setTitle("更新后的标题");

        WorkContact result = workContactService.update(1L, dto);

        assertEquals("更新后的标题", result.getTitle());
        verify(workContactRepository).save(any(WorkContact.class));
    }

    @Test
    @DisplayName("更新工作联系单 - ID不存在应抛出BusinessException")
    void testUpdateNonExistent() {
        when(workContactRepository.findById(999L)).thenReturn(Optional.empty());

        WorkContactDTO dto = buildDTO();
        assertThrows(BusinessException.class, () -> workContactService.update(999L, dto));
        verify(workContactRepository, never()).save(any());
    }

    @Test
    @DisplayName("回复工作联系单 - overdue状态可回复")
    void testReplyOverdueContact() {
        WorkContact contact = buildExisting();
        contact.setStatus("overdue");
        when(workContactRepository.findById(1L)).thenReturn(Optional.of(contact));
        when(workContactRepository.save(any(WorkContact.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ReplyDTO dto = new ReplyDTO();
        dto.setId(1L);
        dto.setReplyContent("逾期回复");

        WorkContact result = workContactService.reply(dto);

        assertEquals("replied", result.getStatus());
        verify(workContactRepository).save(any(WorkContact.class));
    }

    @Test
    @DisplayName("回复工作联系单 - draft状态不可回复应抛出BusinessException")
    void testReplyDraftContact() {
        WorkContact contact = buildExisting();
        contact.setStatus("draft");
        when(workContactRepository.findById(1L)).thenReturn(Optional.of(contact));

        ReplyDTO dto = new ReplyDTO();
        dto.setId(1L);
        dto.setReplyContent("回复内容");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> workContactService.reply(dto));
        assertEquals("只有已发送或已逾期状态的联系单才能回复", exception.getMessage());
        verify(workContactRepository, never()).save(any());
    }

    @Test
    @DisplayName("创建工作联系单 - DTO传入status=sent时应设置status为sent")
    void testCreateWithDTOStatus() {
        WorkContactDTO dto = buildDTO();
        dto.setStatus("sent");
        when(workContactRepository.findByCode(dto.getCode())).thenReturn(Optional.empty());
        when(workContactRepository.save(any(WorkContact.class))).thenAnswer(invocation -> {
            WorkContact contact = invocation.getArgument(0);
            contact.setId(1L);
            return contact;
        });

        WorkContact result = workContactService.create(dto);

        assertEquals("sent", result.getStatus());
    }

    @Test
    @DisplayName("更新工作联系单 - 新code已被其他active记录占用应抛出BusinessException")
    void testUpdateWithDuplicateCode() {
        WorkContact existing = buildExisting();
        WorkContact otherRecord = buildExisting();
        otherRecord.setId(2L);
        otherRecord.setCode("LXD-OTHER");
        when(workContactRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(workContactRepository.findByCode("LXD-OTHER")).thenReturn(Optional.of(otherRecord));

        WorkContactDTO dto = buildDTO();
        dto.setCode("LXD-OTHER");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> workContactService.update(1L, dto));
        assertEquals("编号已存在", exception.getMessage());
        verify(workContactRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新工作联系单 - 新code仅被inactive记录占用时允许更新")
    void testUpdateWithInactiveDuplicateCode() {
        WorkContact existing = buildExisting();
        WorkContact inactiveRecord = buildExisting();
        inactiveRecord.setId(2L);
        inactiveRecord.setCode("LXD-OTHER");
        inactiveRecord.setStatus("inactive");
        when(workContactRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(workContactRepository.findByCode("LXD-OTHER")).thenReturn(Optional.of(inactiveRecord));
        when(workContactRepository.save(any(WorkContact.class))).thenAnswer(invocation -> invocation.getArgument(0));

        WorkContactDTO dto = buildDTO();
        dto.setCode("LXD-OTHER");

        WorkContact result = workContactService.update(1L, dto);

        assertEquals("LXD-OTHER", result.getCode());
        verify(workContactRepository).save(any());
    }

    @Test
    @DisplayName("更新工作联系单 - 新code与自身原code相同允许更新")
    void testUpdateWithSameCode() {
        WorkContact existing = buildExisting();
        when(workContactRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(workContactRepository.save(any(WorkContact.class))).thenAnswer(invocation -> invocation.getArgument(0));

        WorkContactDTO dto = buildDTO();
        dto.setTitle("新标题");

        WorkContact result = workContactService.update(1L, dto);

        assertEquals("新标题", result.getTitle());
        verify(workContactRepository).save(any());
        verify(workContactRepository, never()).findByCode(any());
    }

    @Test
    @DisplayName("删除工作联系单 - 应设置status为inactive")
    void testDeleteWorkContact() {
        WorkContact contact = buildExisting();
        when(workContactRepository.findById(1L)).thenReturn(Optional.of(contact));
        when(workContactRepository.save(any(WorkContact.class))).thenAnswer(invocation -> invocation.getArgument(0));

        workContactService.delete(1L);

        verify(workContactRepository).save(argThat(c -> "inactive".equals(c.getStatus())));
        verify(diaryResources).load("work-contacts", 1L, true);
        verify(diaryReferences).invalidate("work-contacts", contact, true);
    }

    @Test
    @DisplayName("根据ID查询 - 工作联系单不存在应抛出BusinessException")
    void testGetByIdNotFound() {
        when(workContactRepository.findById(999L)).thenReturn(Optional.empty());

        BusinessException exception = assertThrows(BusinessException.class,
                () -> workContactService.getById(999L));
        assertEquals("工作联系单不存在", exception.getMessage());
    }
}